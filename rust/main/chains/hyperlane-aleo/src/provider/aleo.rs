use std::{
    collections::{HashMap, HashSet},
    ops::Deref,
    str::FromStr,
    time::{Duration, Instant},
};

use crate::{
    get_tx_id, to_h256, AleoSigner, BaseHttpClient, ConnectionConf, CurrentNetwork,
    HyperlaneAleoError, RpcClient,
};
use aleo_std_storage::StorageMode;
use async_trait::async_trait;
use futures::future;
use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, FixedPointNumber, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, TxOutcome, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};
use rand_chacha::{rand_core::SeedableRng, ChaCha12Rng, ChaCha20Rng};
use reqwest::Client;
use serde::de::DeserializeOwned;
use snarkvm::{
    ledger::{
        query::Query,
        store::{
            helpers::memory::{BlockMemory, ConsensusMemory},
            ConsensusStore,
        },
        ConfirmedTransaction,
    },
    prelude::{Network, Plaintext, ProgramID, Value, U64, VM},
};
use tracing::{debug, info};

/// Aleo Rest Client
#[derive(Clone)]
pub struct AleoProvider {
    client: RpcClient<BaseHttpClient>,
    domain: HyperlaneDomain,
    signer: Option<AleoSigner>,
    vm: VM<CurrentNetwork, ConsensusMemory<CurrentNetwork>>,
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
    pub fn new(conf: &ConnectionConf, domain: HyperlaneDomain, signer: Option<AleoSigner>) -> Self {
        let base_url = conf.rpc.to_string().trim_end_matches('/').to_string();
        let client = BaseHttpClient::new(Client::new(), base_url);

        // Initializes the VM
        // TODO: check whether or not it is faster to do this one time and one time only
        // TODO: check whether or not the storage can be used in a productino environment on the cloud
        let store = ConsensusStore::open(StorageMode::Production).unwrap();
        let vm: VM<CurrentNetwork, ConsensusMemory<CurrentNetwork>> = VM::from(store).unwrap();
        Self {
            client: RpcClient::new(client),
            domain,
            signer,
            vm,
        }
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
    async fn load_program(&self, program_id: &ProgramID<CurrentNetwork>) -> ChainResult<()> {
        // No need to fetch all imports again when we already added the program to the VM
        if self.vm.contains_program(program_id) {
            return Ok(Default::default());
        }

        debug!("Getting program: {}", program_id);
        let program = self.get_program(&program_id).await?;

        for imports in program.imports().keys() {
            if imports == program_id {
                continue;
            }
            let future = Box::pin(self.load_program(imports));
            future.await?;
        }

        debug!("Adding program: {} to VM", program_id);
        let vm_process = self.vm.process();
        let mut process_guard = vm_process.write();
        process_guard
            .add_program(&program) // TODO: figure out edition
            .map_err(HyperlaneAleoError::from)?;

        Ok(())
    }

    /// Submits a transaction
    /// TODO: consider edition
    pub async fn submit_tx<I, V>(
        &self,
        program_id: &ProgramID<CurrentNetwork>,
        input: I,
        function_name: &str,
    ) -> ChainResult<TxOutcome>
    where
        I: IntoIterator<Item = V>,
        I::IntoIter: ExactSizeIterator, // Aleo only allows static sized inputs
        V: TryInto<Value<CurrentNetwork>>,
    {
        let signer = self.get_signer()?;
        // TODO: Implement QueryTrait for our HttpClient, this will enable seamless usage
        let query = "http://localhost:3030"
            .parse::<Query<CurrentNetwork, BlockMemory<CurrentNetwork>>>()
            .unwrap();

        // Add the program to the VM via the process.

        println!("Adding programs to the vm...");
        let programs_to_add = self.load_program(program_id).await?;
        let input = input.into_iter();

        let mut rng = ChaCha20Rng::from_entropy();
        println!("Creating ZK-Proof for: {}", function_name);
        let start = Instant::now();
        let transaction = self
            .vm
            .execute(
                signer.get_private_key(),
                (program_id, function_name),
                input,
                None,
                0u64,
                Some(&query),
                &mut rng,
            )
            .map_err(HyperlaneAleoError::from)?;
        let time = Instant::now().duration_since(start);
        println!("Proofing time: {}s", time.as_secs());

        let id = transaction.id();
        let hash = transaction.id().to_string();
        println!("Submitting tx: {}", hash);
        let output = self.broadcast_transaction(transaction).await?;

        if output != hash {
            return Err(HyperlaneAleoError::Other(format!(
                "Transaction revered with reason: {}",
                output
            ))
            .into());
        }

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
                    println!("Transaction still pending, continuing to poll: {}", hash,);
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

        let outcome = TxOutcome {
            transaction_id: to_h256(id)?.into(),
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
        let block = self.get_block(height as u32).await?;
        let hash = to_h256(block.hash())?;
        let timestamp = block.timestamp() as u64;
        Ok(BlockInfo {
            hash,
            timestamp,
            number: block.height().into(),
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
        let nonce = 0u32;
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
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        // TODO: query the mailbox to see whether or not the address is known
        Ok(true)
    }

    /// Fetch the balance of the wallet address associated with the chain provider.
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let signer = self.get_signer()?;
        let balance: U64<CurrentNetwork> = self
            .get_mapping_value("credits.aleo", "account", signer.address())
            .await?;
        Ok(U256::from(*balance))
    }

    /// Fetch metrics related to this chain
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        // TODO
        Ok(None)
    }
}
