use std::{
    fmt::Debug,
    ops::Deref,
    str::FromStr,
    time::{Duration, Instant},
};

use aleo_std::StorageMode;
use async_trait::async_trait;
use rand_chacha::{rand_core::SeedableRng, ChaCha20Rng};
use snarkvm::{
    ledger::{
        store::{helpers::memory::ConsensusMemory, ConsensusStore},
        ConfirmedTransaction,
    },
    prelude::{
        cost_in_microcredits_v3, execution_cost_for_authorization, Authorization, CanaryV0,
        Identifier, MainnetV0, Network, ProgramID, TestnetV0, Value, VM,
    },
};
use snarkvm_console_account::{Address, PrivateKey};
use tracing::debug;

use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, FixedPointNumber, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, TxOutcome, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;

use crate::{
    provider::{fallback::FallbackHttpClient, HttpClient, ProvingClient, RpcClient},
    utils::{get_tx_id, to_h256},
    AleoSigner, ConnectionConf, CurrentNetwork, FeeEstimate, HyperlaneAleoError,
};

/// Aleo Http Client trait alias
pub trait AleoClient: HttpClient + Clone + Debug + Send + Sync + 'static {}
impl<T> AleoClient for T where T: HttpClient + Clone + Debug + Send + Sync + 'static {}

/// Aleo Rest Client. Generic over an underlying HttpClient to allow injection of a mock for testing.
#[derive(Debug, Clone)]
pub struct AleoProvider<C: AleoClient = FallbackHttpClient> {
    client: RpcClient<C>,
    domain: HyperlaneDomain,
    network: u16,
    proving_service: Option<ProvingClient<C>>,
    signer: Option<AleoSigner>,
    priority_fee_multiplier: f64,
}

impl AleoProvider<FallbackHttpClient> {
    /// Creates a new production AleoProvider
    pub fn new(
        conf: &ConnectionConf,
        domain: HyperlaneDomain,
        signer: Option<AleoSigner>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
    ) -> ChainResult<Self> {
        let proving_service = if !conf.proving_service.is_empty() {
            let client = FallbackHttpClient::new(
                conf.proving_service.clone(),
                metrics.clone(),
                chain.clone(),
            )?;
            Some(ProvingClient::new(client))
        } else {
            None
        };

        Ok(Self {
            client: RpcClient::new(FallbackHttpClient::new(conf.rpcs.clone(), metrics, chain)?),
            domain,
            network: conf.chain_id,
            proving_service,
            signer,
            priority_fee_multiplier: conf.priority_fee_multiplier,
        })
    }
}

impl<C: AleoClient> AleoProvider<C> {
    #[cfg(test)]
    /// Generic constructor allowing a pre-built client (used in tests with a mock client)
    pub fn with_client(
        client: C,
        domain: HyperlaneDomain,
        chain_id: u16,
        signer: Option<AleoSigner>,
    ) -> Self {
        Self {
            client: RpcClient::new(client),
            domain,
            network: chain_id,
            proving_service: None,
            signer: signer,
            priority_fee_multiplier: 0.0,
        }
    }

    /// Returns the current chain id
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
        depth: usize,
    ) -> ChainResult<()> {
        if depth > N::MAX_IMPORTS {
            return Err(HyperlaneAleoError::Other(format!(
                "Exceeded maximum program import depth when loading program: {program_id}",
            ))
            .into());
        }

        // No need to fetch all imports again when we already added the program to the VM
        if vm.contains_program(program_id) {
            return Ok(());
        }

        debug!("Getting program: {}", program_id);
        let program = self.get_program(program_id).await?;

        for import in program.imports().keys() {
            let future = Box::pin(self.load_program(vm, import, depth.saturating_add(1)));
            future.await?;
        }

        debug!("Adding program: {} to VM", program_id);
        let vm_process = vm.process();
        let mut process_guard = vm_process.write();
        process_guard
            .add_program(&program)
            .map_err(HyperlaneAleoError::from)?;

        Ok(())
    }

    /// Calculates the cost of a function in microcredits
    /// This function assumes that the program and all its imports are already loaded into the VM
    async fn calculate_function_costs<N: Network>(
        &self,
        vm: &VM<N, ConsensusMemory<N>>,
        authorization: &Authorization<N>,
        program_id: &ProgramID<N>,
        function_name: &Identifier<N>,
    ) -> ChainResult<u64> {
        // Get the stack for the program.
        let stack = vm
            .process()
            .read()
            .get_stack(program_id)
            .map_err(HyperlaneAleoError::from)?;

        let height = self.get_latest_height().await?;
        let consensus_version = N::CONSENSUS_VERSION(height).map_err(HyperlaneAleoError::from)?;

        // Get the finalize cost.
        let finalize_cost =
            cost_in_microcredits_v3(&stack, function_name).map_err(HyperlaneAleoError::from)?;
        let execution_cost = execution_cost_for_authorization(
            &vm.process().read(),
            authorization,
            consensus_version,
        )
        .map_err(HyperlaneAleoError::from)?
        .0;

        // Return the function cost, which is the sum of the finalize and execution costs.
        Ok(finalize_cost.saturating_add(execution_cost))
    }

    /// Internal helper: builds VM, loads program + imports, parses identifiers, and creates authorization.
    async fn prepare_authorization_and_vm<N: Network, I, V>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
    ) -> ChainResult<(
        VM<N, ConsensusMemory<N>>,
        Authorization<N>,
        ProgramID<N>,
        Identifier<N>,
        PrivateKey<N>,
        ChaCha20Rng,
    )>
    where
        I: IntoIterator<Item = V>,
        I::IntoIter: ExactSizeIterator,
        V: TryInto<Value<N>>,
    {
        let program_id_parsed =
            ProgramID::<N>::from_str(program_id).map_err(HyperlaneAleoError::from)?;
        let function_name_parsed =
            Identifier::<N>::from_str(function_name).map_err(HyperlaneAleoError::from)?;
        let store =
            ConsensusStore::open(StorageMode::Production).map_err(HyperlaneAleoError::from)?;
        let vm: VM<N, ConsensusMemory<N>> = VM::from(store).map_err(HyperlaneAleoError::from)?;
        let signer = self.get_signer()?;
        let private_key = signer.get_private_key()?;
        let mut rng = ChaCha20Rng::from_entropy();
        // Load program + dependencies.
        self.load_program(&vm, &program_id_parsed, 0).await?;
        // Create authorization.
        let authorization = vm
            .authorize(
                &private_key,
                program_id_parsed,
                function_name_parsed,
                input.into_iter(),
                &mut rng,
            )
            .map_err(HyperlaneAleoError::from)?;
        Ok((
            vm,
            authorization,
            program_id_parsed,
            function_name_parsed,
            private_key,
            rng,
        ))
    }

    fn get_priority_fee(&self, base_fee: u64) -> u64 {
        (base_fee as f64 * self.priority_fee_multiplier)
            .round()
            .max(0.0)
            .min(u64::MAX as f64) as u64
    }

    /// Generic estimation function (no proving, no broadcast).
    pub async fn estimate<N: Network, I, V>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
    ) -> ChainResult<FeeEstimate>
    where
        I: IntoIterator<Item = V>,
        I::IntoIter: ExactSizeIterator,
        V: TryInto<Value<N>>,
    {
        let (vm, authorization, program_id_parsed, function_name_parsed, _pk, _rng) = self
            .prepare_authorization_and_vm::<N, I, V>(program_id, function_name, input)
            .await?;
        let base = self
            .calculate_function_costs::<N>(
                &vm,
                &authorization,
                &program_id_parsed,
                &function_name_parsed,
            )
            .await?;
        let priority = self.get_priority_fee(base);
        Ok(FeeEstimate::new(base, priority))
    }

    /// Public estimation entrypoint selecting the network
    pub async fn estimate_tx<I>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
    ) -> ChainResult<FeeEstimate>
    where
        I: IntoIterator<Item = String>,
        I::IntoIter: ExactSizeIterator,
    {
        match self.chain_id() {
            0 => {
                self.estimate::<MainnetV0, _, _>(program_id, function_name, input)
                    .await
            }
            1 => {
                self.estimate::<TestnetV0, _, _>(program_id, function_name, input)
                    .await
            }
            2 => {
                self.estimate::<CanaryV0, _, _>(program_id, function_name, input)
                    .await
            }
            id => Err(HyperlaneAleoError::UnknownNetwork(id).into()),
        }
    }

    /// Executes the transaction for the given network
    async fn execute<N: Network, I, V>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = V>,
        I::IntoIter: ExactSizeIterator,
        V: TryInto<Value<N>>,
    {
        debug!("Creating ZK-Proof for: {}/{}", program_id, function_name);
        // Prepare VM + Authorization for execution.
        let (vm, authorization, program_id_parsed, function_name_parsed, private_key, mut rng) =
            self.prepare_authorization_and_vm::<N, I, V>(program_id, function_name, input)
                .await?;

        let start = Instant::now();
        // Calculate fees
        let base_fee = self
            .calculate_function_costs::<N>(
                &vm,
                &authorization,
                &program_id_parsed,
                &function_name_parsed,
            )
            .await?;
        let priority_fee = self.get_priority_fee(base_fee);

        // Authorize fee payment.
        let fee = vm
            .authorize_fee_public(
                &private_key,
                base_fee,
                priority_fee,
                authorization
                    .to_execution_id()
                    .map_err(HyperlaneAleoError::from)?,
                &mut rng,
            )
            .map_err(HyperlaneAleoError::from)?;
        let time = Instant::now().duration_since(start);

        // Either use the proving service or generate the proof locally
        let transaction = match self.proving_service {
            Some(ref client) => client.proving_request(authorization, fee).await,
            None => Ok(vm
                .execute_authorization(authorization, Some(fee), Some(&self.client), &mut rng)
                .map_err(HyperlaneAleoError::from)?),
        }?;

        debug!("ZK Proof generation took: {:.2}s", time.as_secs_f32());

        let id = transaction.id();
        debug!("Submitting tx: {}", id);
        let output = self.broadcast_transaction(transaction).await?;
        if output != id.to_string() {
            return Err(HyperlaneAleoError::Other(format!(
                "Transaction reverted with reason: {output}"
            ))
            .into());
        }

        // Return transaction hash
        let tx_hash = to_h256(id).map(|h| h.into())?;
        Ok(tx_hash)
    }

    /// Submits a transaction and returns the transaction ID immediately without waiting for confirmation
    pub async fn submit_tx<I>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = String>,
        I::IntoIter: ExactSizeIterator,
    {
        match self.chain_id() {
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
        }
    }

    /// Submits a transaction and waits for confirmation, returning the transaction outcome
    /// This method polls for up to 30 seconds waiting for the transaction to be confirmed
    pub async fn submit_tx_and_wait<I>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
    ) -> ChainResult<TxOutcome>
    where
        I: IntoIterator<Item = String>,
        I::IntoIter: ExactSizeIterator,
    {
        let hash = self.submit_tx(program_id, function_name, input).await?;

        // Polling delay is the total amount of seconds to wait before we call a timeout
        const TIMEOUT_DELAY: u64 = 30;
        const POLLING_INTERVAL: u64 = 2;
        const NUM_RETRIES: usize = (TIMEOUT_DELAY / POLLING_INTERVAL) as usize;
        let mut attempt: usize = 0;

        let confirmed_tx = loop {
            let result = self.get_confirmed_transaction(hash).await;
            match result {
                Ok(confirmed) => {
                    break Ok::<ConfirmedTransaction<CurrentNetwork>, ChainCommunicationError>(
                        confirmed,
                    )
                }
                _ => {
                    debug!("Transaction still pending, continuing to poll: {hash} {attempt}",);
                    // Transaction is still pending, continue polling
                    attempt = attempt.saturating_add(1);
                    if attempt >= NUM_RETRIES {
                        return Err(HyperlaneAleoError::Other(format!(
                            "Transaction timed out after {TIMEOUT_DELAY} seconds"
                        ))
                        .into());
                    }
                    tokio::time::sleep(Duration::from_secs(POLLING_INTERVAL)).await;
                    continue;
                }
            }
        }?;

        let fee = confirmed_tx
            .fee_amount()
            .map_err(HyperlaneAleoError::from)?;

        // There is no concept of gas for Aleo, only the total credits that were spent
        // We mimic gas by setting the gas price to 1 and using the tokens spent as the gas_used
        Ok(TxOutcome {
            transaction_id: to_h256(confirmed_tx.id())?.into(),
            executed: !confirmed_tx.is_rejected(),
            gas_used: U256::from(*fee),
            gas_price: FixedPointNumber::from_str("1")?,
        })
    }
}

impl<C: AleoClient> Deref for AleoProvider<C> {
    type Target = RpcClient<C>;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl<C: AleoClient> HyperlaneChain for AleoProvider<C> {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl<C: AleoClient> HyperlaneProvider for AleoProvider<C> {
    /// Get block info for a given block height
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let height = height as u32;
        let (hash, timestamp) = match self.chain_id() {
            0 => {
                let block = self.get_block::<MainnetV0>(height).await?;
                (to_h256(block.hash())?, block.timestamp())
            }
            1 => {
                let block = self.get_block::<TestnetV0>(height).await?;
                (to_h256(block.hash())?, block.timestamp())
            }
            2 => {
                let block = self.get_block::<CanaryV0>(height).await?;
                (to_h256(block.hash())?, block.timestamp())
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
        let tx_id = get_tx_id::<CurrentNetwork>(*hash)?;
        let tx_id = tx_id.to_string();
        let transaction = self.get_transaction(&tx_id).await?;
        // Aleo doesn't have a concept of gas, we use the paid tokens as the gas limit and say that the gas_price is always one
        let gas_limit = transaction.fee_amount().map(|x| *x).unwrap_or(0u64);

        // We assume that the fee payer is the sender of the transaction
        let sender = transaction
            .fee_transition()
            .and_then(|fee_tx| fee_tx.payer())
            .map(to_h256)
            .transpose()?
            .unwrap_or_else(H256::zero);

        // Assume that the first transitions program id is the recipient of the transaction
        // One transaction can actually have multiple recipients
        let recipient = transaction
            .transitions()
            .next()
            .map(|transition| transition.program_id().to_address())
            .transpose()
            .map_err(HyperlaneAleoError::from)?
            .map(to_h256)
            .transpose()?;

        Ok(TxnInfo {
            hash: *hash,
            gas_limit: gas_limit.into(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: Some(U256::one()),
            gas_price: Some(U256::one()),
            nonce: 0, // Aleo doesn't have nonces, they use different random seeds upon ZKP generation as a replay protection
            sender,
            recipient,
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
        // We can't check whether or not an address is a deploy contract on aleo
        // We can only check when we have the ProgramID
        Ok(true)
    }

    /// Fetch the balance of the wallet address associated with the chain provider.
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let address = Address::from_str(&address).map_err(HyperlaneAleoError::from)?;
        let balance: u64 = self
            .get_mapping_value("credits.aleo", "account", &address)
            .await?
            .unwrap_or_default();
        Ok(U256::from(balance))
    }

    /// Fetch metrics related to this chain
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        let height = self.get_latest_height().await?;
        let info = self.get_block_by_height(height as u64).await?;
        Ok(Some(ChainInfo {
            latest_block: info,
            min_gas_price: None,
        }))
    }
}
