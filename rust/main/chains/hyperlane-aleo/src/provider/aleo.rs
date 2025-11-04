use std::{
    ops::Deref,
    str::FromStr,
    time::{Duration, Instant},
};

use crate::{
    utils::{get_tx_id, to_h256},
    AleoSigner, BaseHttpClient, ConnectionConf, CurrentNetwork, HyperlaneAleoError, RpcClient,
};
use aleo_std_storage::StorageMode;
use async_trait::async_trait;
use rand_chacha::{rand_core::SeedableRng, ChaCha20Rng};
use reqwest::Client;
use snarkvm::{
    ledger::{
        store::{helpers::memory::ConsensusMemory, ConsensusStore},
        ConfirmedTransaction,
    },
    prelude::{CanaryV0, MainnetV0, Network, ProgramID, TestnetV0, Value, VM},
};
use snarkvm_console_account::{Address, Itertools};
use tracing::debug;

use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, FixedPointNumber, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, TxOutcome, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};

/// Aleo Rest Client
#[derive(Clone)]
pub struct AleoProvider {
    client: RpcClient<BaseHttpClient>,
    domain: HyperlaneDomain,
    signer: Option<AleoSigner>,
    network: u16,
}

impl std::fmt::Debug for AleoProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AleoProvider")
            .field("client", &self.client)
            .field("domain", &self.domain)
            .finish()
    }
}

impl AleoProvider {
    /// Creates a new HTTP client for the Aleo API
    pub fn new(
        conf: &ConnectionConf,
        domain: HyperlaneDomain,
        signer: Option<AleoSigner>,
    ) -> ChainResult<Self> {
        let base_url = conf.rpc.to_string().trim_end_matches('/').to_string();
        let client = BaseHttpClient::new(Client::new(), base_url);

        Ok(Self {
            client: RpcClient::new(client),
            domain,
            signer,
            network: conf.chain_id,
        })
    }

    /// Returns the chain id of the configured network
    pub fn chain_id(&self) -> u16 {
        self.network
    }

    /// Get the Aleo Signer
    pub fn get_signer(&self) -> ChainResult<&AleoSigner> {
        let signer = self
            .signer
            .as_ref()
            .ok_or(HyperlaneAleoError::SignerMissing)?;
        Ok(signer)
    }

    /// Returns a total list of programs that are used for the given program_id
    async fn load_program<N: Network>(
        &self,
        vm: &VM<N, ConsensusMemory<N>>,
        program_id: &ProgramID<N>,
    ) -> ChainResult<()> {
        // No need to fetch all imports again when we already added the program to the VM
        if vm.contains_program(program_id) {
            return Ok(Default::default());
        }

        debug!("Getting program: {}", program_id);
        let program = self.get_program(&program_id).await?;

        for imports in program.imports().keys() {
            if imports == program_id {
                continue;
            }
            let future = Box::pin(self.load_program(vm, imports));
            future.await?;
        }

        debug!("Adding program: {} to VM", program_id);
        let vm_process = vm.process();
        let mut process_guard = vm_process.write();
        process_guard
            .add_program(&program) // TODO: figure out edition
            .map_err(HyperlaneAleoError::from)?;

        Ok(())
    }

    /// Executes the transactions for the given network
    /// Creates a new VM for that network and loads every program that is necessary
    /// Submits the transaction and returns either the error or the hash of the transaction
    async fn execute<N: Network, I, V>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
    ) -> ChainResult<String>
    where
        I: IntoIterator<Item = V>,
        I::IntoIter: ExactSizeIterator, // Aleo only allows static sized inputs
        V: TryInto<Value<N>>,
    {
        let start = Instant::now();
        debug!("Creating ZK-Proof for: {}/{}", program_id, function_name);

        let program_id = ProgramID::<N>::from_str(program_id).map_err(HyperlaneAleoError::from)?;
        // Initializes the VM
        let store =
            ConsensusStore::open(StorageMode::Production).map_err(HyperlaneAleoError::from)?;
        let vm: VM<N, ConsensusMemory<N>> = VM::from(store).map_err(HyperlaneAleoError::from)?;

        let signer = self.get_signer()?;
        let mut rng = ChaCha20Rng::from_entropy();
        self.load_program(&vm, &program_id).await?;

        let transaction = vm
            .execute(
                &signer.get_private_key()?,
                (program_id, function_name),
                input.into_iter(),
                None,
                0u64,
                Some(&self.client),
                &mut rng,
            )
            .map_err(HyperlaneAleoError::from)?;

        let time = Instant::now().duration_since(start);

        debug!(
            program_id = program_id.to_string(),
            function_name = function_name,
            tx_id = transaction.id().to_string(),
            "ZK Proof generation took: {:.2}s",
            time.as_secs_f32()
        );

        let id = transaction.id();
        debug!("Submitting tx: {}", id);
        let output = self.broadcast_transaction(transaction).await?;

        if output != id.to_string() {
            return Err(HyperlaneAleoError::Other(format!(
                "Transaction revered with reason: {}",
                output
            ))
            .into());
        }

        Ok(output)
    }

    /// Submits a transaction
    pub async fn submit_tx(
        &self,
        program_id: &str,
        input: impl IntoIterator<Item = String>,
        function_name: &str,
    ) -> ChainResult<TxOutcome> {
        let input = input.into_iter().collect_vec();
        let hash = match self.chain_id() {
            0 => {
                // Mainnet
                self.execute::<MainnetV0, _, _>(program_id, function_name, input)
                    .await
            }
            1 => {
                // Testnet
                self.execute::<TestnetV0, _, _>(program_id, function_name, input)
                    .await
            }
            2 => {
                // Canary
                self.execute::<CanaryV0, _, _>(program_id, function_name, input)
                    .await
            }
            id => Err(HyperlaneAleoError::UnknownNetwork(id).into()),
        }?;

        // Polling delay is the total amount of seconds to wait before we call a timeout
        const TIMEOUT_DELAY: u64 = 60;
        const POLLING_INTERVAL: u64 = 2;
        const N: usize = (TIMEOUT_DELAY / POLLING_INTERVAL) as usize;
        let mut attempt = 0;

        let status = loop {
            let confirmed_tx = self.get_transaction_status(&hash).await;
            match confirmed_tx {
                Ok(confirmed) => {
                    break Ok::<ConfirmedTransaction<CurrentNetwork>, ChainCommunicationError>(
                        confirmed,
                    )
                }
                _ => {
                    debug!(
                        hash = hash,
                        attempt = attempt,
                        "Transaction still pending, continuing to poll",
                    );
                    // Transaction is still pending, continue polling
                    attempt += 1;
                    if attempt >= N {
                        return Err(HyperlaneAleoError::Other(format!(
                            "Transaction timed out after {} seconds",
                            TIMEOUT_DELAY
                        ))
                        .into());
                    }
                    tokio::time::sleep(Duration::from_secs(POLLING_INTERVAL)).await;
                    continue;
                }
            }
        }?;

        let fee = status.fee_amount().map_err(HyperlaneAleoError::from)?;

        // There is no concept of gas for Aleo, only the total credits that were spent
        // We mimic gas by setting the gas price to 1 and using the tokens spent as the gas_used
        let outcome = TxOutcome {
            transaction_id: to_h256(status.id())?.into(),
            executed: !status.is_rejected(),
            gas_used: U256::from(*fee),
            gas_price: FixedPointNumber::from_str("1")?,
        };
        Ok(outcome)
    }
}

impl Deref for AleoProvider {
    type Target = RpcClient<BaseHttpClient>;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl HyperlaneChain for AleoProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for AleoProvider {
    /// Get block info for a given block height
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let height = height as u32;
        let (hash, timestamp) = match self.chain_id() {
            0 => {
                let block = self.get_block::<MainnetV0>(height).await?;
                (to_h256(&block)?, block.timestamp())
            }
            1 => {
                let block = self.get_block::<TestnetV0>(height).await?;
                (to_h256(&block)?, block.timestamp())
            }
            2 => {
                let block = self.get_block::<CanaryV0>(height).await?;
                (to_h256(&block)?, block.timestamp())
            }
            id => return Err(HyperlaneAleoError::UnknownNetwork(id).into()),
        };
        Ok(BlockInfo {
            hash,
            timestamp: timestamp as u64,
            number: height.into(),
        })
    }

    /// Get txn info for a given txn hash
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let tx_id = get_tx_id(*hash)?;
        let tx_id = tx_id.to_string();
        let transaction = self.get_transaction(&tx_id).await?;
        // Aleo doesn't have a concept of gas, we use the paid tokens as the gas limit and say that the gas_price is always one
        let gas_limit = transaction.fee_amount().map(|x| *x).unwrap_or(0u64);

        // We assume that the fee payer is the sender of the transaction
        let sender = transaction
            .fee_transition()
            .and_then(|fee_tx| fee_tx.payer())
            .map(|payer| to_h256(payer))
            .transpose()?
            .unwrap_or_else(H256::zero);

        // Aleo doesn't have nonces
        Ok(TxnInfo {
            hash: *hash,
            gas_limit: gas_limit.into(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: Some(U256::one()),
            gas_price: Some(U256::one()),
            nonce: 0,
            sender,
            recipient: None, // TODO: We could parse the first transition that is executed and interpret the program id as a address
            receipt: Some(TxnReceiptInfo {
                gas_used: gas_limit.into(),
                cumulative_gas_used: gas_limit.into(),
                effective_gas_price: Some(U256::one()),
            }),
            raw_input_data: None,
        })
    }

    /// Returns whether a contract exists at the provided address
    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // TODO: query the mailbox to see whether or not the address is known
        Ok(true)
    }

    /// Fetch the balance of the wallet address associated with the chain provider.
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let address = Address::from_str(&address).map_err(HyperlaneAleoError::from)?;
        let balance: u64 = self
            .get_mapping_value("credits.aleo", "account", &address)
            .await?;
        Ok(U256::from(balance))
    }

    /// Fetch metrics related to this chain
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        // TODO
        Ok(None)
    }
}
