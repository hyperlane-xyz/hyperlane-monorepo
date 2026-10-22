use std::{
    collections::{BTreeMap, HashMap},
    fmt::Debug,
    ops::Deref,
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant},
};

use aleo_std::StorageMode;
use async_trait::async_trait;
use rand::rngs::SysRng;
use rand_chacha::{rand_core::SeedableRng, ChaCha20Rng};
use snarkvm::{
    circuit::{Aleo, AleoCanaryV0, AleoTestnetV0, AleoV0},
    ledger::{
        store::{helpers::memory::ConsensusMemory, ConsensusStore},
        ConfirmedTransaction,
    },
    prelude::{
        execution_cost_for_authorization, minimum_cost_in_microcredits_v3, Authorization, CanaryV0,
        Identifier, MainnetV0, Network, ProgramID, TestnetV0, Value, VM,
    },
};
use snarkvm_console_account::{Address, PrivateKey};
use tokio::sync::{OnceCell, RwLock};
use tracing::{debug, warn};

use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, FixedPointNumber, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, TxOutcome, TxnInfo, TxnReceiptInfo,
    H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;

use crate::{
    provider::{
        fallback::FallbackHttpClient,
        metric::{record_execution_phase, ExecutionPhase},
        vm_thread, AleoClient, BaseHttpClient, JWTBaseHttpClient, ProvingClient, RpcClient,
    },
    utils::{get_tx_id, to_h256},
    AleoSigner, ConnectionConf, CurrentNetwork, FeeEstimate, HyperlaneAleoError,
};

#[derive(Debug, Clone, Hash, Eq, PartialEq)]
struct FeeEstimateCacheKey {
    program_id: String,
    function_name: String,
    network_id: u16,
}

type LazyVm<N> = Arc<OnceCell<VM<N, ConsensusMemory<N>>>>;

const BLOCK_METADATA_CACHE_SIZE: usize = 128;

// Metadata reads trust the finalized RPC response, including its outer block
// hash without cross-checking it against the header, as on other VMs. Decoding
// a snarkVM Block also verifies consensus certificates and decodes transactions,
// which is unnecessary for the hash/height/timestamp used by indexing.
#[derive(serde::Deserialize)]
#[serde(bound = "")]
struct BlockMetadata<N: Network> {
    block_hash: N::BlockHash,
    header: BlockMetadataHeader,
}

#[derive(serde::Deserialize)]
struct BlockMetadataHeader {
    metadata: BlockMetadataFields,
}

#[derive(serde::Deserialize)]
struct BlockMetadataFields {
    height: u32,
    timestamp: u64,
}

/// Aleo Rest Client. Generic over an underlying HttpClient to allow injection of a mock for testing.
#[derive(Clone)]
pub struct AleoProvider<C: AleoClient = FallbackHttpClient> {
    client: RpcClient<C>,
    execution_metrics: PrometheusClientMetrics,
    execution_metrics_config: hyperlane_metric::prometheus_metric::PrometheusConfig,
    domain: HyperlaneDomain,
    network: u16,
    proving_service: Option<ProvingClient<FallbackHttpClient<JWTBaseHttpClient>>>,
    signer: Option<AleoSigner>,
    priority_fee_multiplier: f64,
    estimate_cache: Arc<RwLock<HashMap<FeeEstimateCacheKey, FeeEstimate>>>,
    // Aleo blocks are finalized. Within this provider, reuse metadata across
    // near-head observation and confirmation. Confirmation re-reads therefore
    // do not reach RPC; a bad hash from a fallback RPC remains until eviction.
    // Retain only the highest recently requested heights.
    block_metadata: Arc<RwLock<BTreeMap<u32, BlockInfo>>>,
    // Read-only ISM and indexing providers never need a VM. Initialize only
    // the execution network, sharing it with provider clones. The pinned
    // snarkVM lifecycle fix releases its worker after the last clone drops.
    mainnet_vm: LazyVm<MainnetV0>,
    testnet_vm: LazyVm<TestnetV0>,
    canary_vm: LazyVm<CanaryV0>,
}

impl<C: AleoClient> std::fmt::Debug for AleoProvider<C> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AleoProvider")
            .field("domain", &self.domain)
            .field("network", &self.network)
            .field(
                "proving_service",
                if self.proving_service.is_some() {
                    &"Some(ProvingClient)"
                } else {
                    &"None"
                },
            )
            .field(
                "signer",
                if self.signer.is_some() {
                    &"Some(AleoSigner)"
                } else {
                    &"None"
                },
            )
            .field("priority_fee_multiplier", &self.priority_fee_multiplier)
            .finish()
    }
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
        let proving_service = if !conf.proving_service.expose_secret().is_empty() {
            let client = FallbackHttpClient::new_delegated_prover(
                conf.proving_service.expose_secret().clone(),
                metrics.clone(),
                chain.clone(),
                conf.chain_id,
            )?;
            Some(ProvingClient::new(client))
        } else {
            None
        };

        Ok(Self {
            client: RpcClient::new(FallbackHttpClient::new::<BaseHttpClient>(
                conf.rpcs.expose_secret().clone(),
                metrics.clone(),
                chain.clone(),
                conf.chain_id,
            )?),
            execution_metrics: metrics,
            execution_metrics_config: hyperlane_metric::prometheus_metric::PrometheusConfig {
                chain,
                ..Default::default()
            },
            domain,
            network: conf.chain_id,
            proving_service,
            signer,
            priority_fee_multiplier: conf.priority_fee_multiplier,
            estimate_cache: Default::default(),
            block_metadata: Default::default(),
            mainnet_vm: Default::default(),
            testnet_vm: Default::default(),
            canary_vm: Default::default(),
        })
    }
}

async fn get_vm<N: Network>(
    cell: &OnceCell<VM<N, ConsensusMemory<N>>>,
) -> ChainResult<&VM<N, ConsensusMemory<N>>> {
    cell.get_or_try_init(|| async {
        tokio::task::spawn_blocking(|| {
            let store =
                ConsensusStore::open(StorageMode::Production).map_err(HyperlaneAleoError::from)?;
            VM::from(store).map_err(|err| HyperlaneAleoError::from(err).into())
        })
        .await
        .map_err(|err| HyperlaneAleoError::Other(format!("VM initialization task failed: {err}")))?
    })
    .await
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
            execution_metrics: Default::default(),
            execution_metrics_config: Default::default(),
            domain,
            network: chain_id,
            proving_service: None,
            signer,
            priority_fee_multiplier: 0.0,
            estimate_cache: Default::default(),
            block_metadata: Default::default(),
            mainnet_vm: Default::default(),
            testnet_vm: Default::default(),
            canary_vm: Default::default(),
        }
    }

    /// Returns the current chain id
    pub fn chain_id(&self) -> u16 {
        self.network
    }

    async fn fetch_block_metadata<N: Network>(&self, height: u32) -> ChainResult<BlockInfo> {
        let block: BlockMetadata<N> = self.request(&format!("block/{height}"), None).await?;
        let metadata = block.header.metadata;
        if metadata.height != height {
            return Err(HyperlaneProviderError::IncorrectBlockByHeight(
                u64::from(height),
                u64::from(metadata.height),
            )
            .into());
        }
        Ok(BlockInfo {
            hash: to_h256(block.block_hash)?,
            timestamp: metadata.timestamp,
            number: u64::from(metadata.height),
        })
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
        let latest_edition = self.get_latest_edition(program_id).await?;
        let program = self
            .get_program_by_edition(program_id, latest_edition)
            .await?;

        for import in program.imports().keys() {
            let future = Box::pin(self.load_program(vm, import, depth.saturating_add(1)));
            future.await?;
        }

        debug!("Adding program: {} to VM", program_id);
        vm.process()
            .lock()
            .add_program_with_edition(&program, latest_edition)
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
            .get_stack(program_id)
            .map_err(HyperlaneAleoError::from)?;

        let height = self.get_latest_height().await?;
        let consensus_version = N::CONSENSUS_VERSION(height).map_err(HyperlaneAleoError::from)?;

        // Get the finalize cost. This is a lower bound (not the exact runtime cost) because we
        // only have an Authorization at this point, not a proven Execution: the exact cost
        // (`execution_finalize_cost`) requires iterating over concrete transitions, which don't
        // exist yet. `execution_cost_for_authorization` below has the same limitation, returning
        // a `MinimumCost`.
        let finalize_cost = minimum_cost_in_microcredits_v3(&stack, function_name)
            .map_err(HyperlaneAleoError::from)?;
        let execution_cost =
            execution_cost_for_authorization(vm.process(), authorization, consensus_version)
                .map_err(HyperlaneAleoError::from)?
                .0;

        // Return the function cost, which is the sum of the finalize and execution costs.
        Ok(finalize_cost.saturating_add(execution_cost))
    }

    /// Internal helper: checks for malicious authorizations
    /// Because in Aleo the application is the entry point, we have to trust the application to not contain malicious code
    /// Malicious code can drain the relayer's account out of credits and tokens
    fn malicious_authorization_check<N: Network>(
        &self,
        entry_program_id: &str,
        authorization: &Authorization<N>,
    ) -> ChainResult<()> {
        for (_, transition) in authorization.transitions() {
            let program_id = transition.program_id().to_string();

            // Native credits transfers from the signer are malicious
            // Token transfers from the signer are malicious
            if (program_id == "credits.aleo" || program_id == "token_registry.aleo")
                && transition.function_name().to_string() == "transfer_public_as_signer"
            {
                return Err(HyperlaneAleoError::MaliciousProgramDetected {
                    program_id: entry_program_id.to_string(),
                    transition: transition.to_string(),
                }
                .into());
            }
        }
        Ok(())
    }

    /// Internal helper: builds VM, loads program + imports, parses identifiers, and creates authorization.
    async fn prepare_authorization<N: Network, A: Aleo<Network = N>, I, V>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
        vm: &VM<N, ConsensusMemory<N>>,
        unchecked: bool,
    ) -> ChainResult<(
        Authorization<N>,
        ProgramID<N>,
        Identifier<N>,
        PrivateKey<N>,
        ChaCha20Rng,
    )>
    where
        I: IntoIterator<Item = V>,
        I::IntoIter: ExactSizeIterator,
        V: TryInto<Value<N>> + Send + 'static,
    {
        let start = Instant::now();
        debug!(
            "Preparing Authorization for: {}/{}",
            program_id, function_name
        );
        let program_id_parsed =
            ProgramID::<N>::from_str(program_id).map_err(HyperlaneAleoError::from)?;
        let function_name_parsed =
            Identifier::<N>::from_str(function_name).map_err(HyperlaneAleoError::from)?;
        let signer = self.get_signer()?;
        let private_key = signer.get_private_key()?;
        let mut rng = ChaCha20Rng::try_from_rng(&mut SysRng)
            .map_err(|e| HyperlaneAleoError::Other(format!("RNG seeding failed: {e}")))?;
        // Load program + dependencies.
        self.load_program(vm, &program_id_parsed, 0).await?;

        debug!(
            "Loaded Program and dependencies in {:.2}s",
            Instant::now().duration_since(start).as_secs_f32()
        );

        // Delegated proving only needs evaluated transitions; the prover checks
        // circuit satisfiability while generating the proof.
        let inputs: Vec<V> = input.into_iter().collect();
        let job_vm = vm.clone();
        let (authorization, rng) = vm_thread::run(move || {
            let authorization = if unchecked {
                job_vm
                    .process()
                    .authorize_unchecked::<A, _>(
                        &private_key,
                        program_id_parsed,
                        function_name_parsed,
                        inputs.into_iter(),
                        &mut rng,
                    )
                    .map_err(anyhow::Error::from)
            } else {
                job_vm
                    .authorize(
                        &private_key,
                        program_id_parsed,
                        function_name_parsed,
                        inputs.into_iter(),
                        &mut rng,
                    )
                    .map_err(anyhow::Error::from)
            };
            (authorization, rng)
        })
        .await?;
        let authorization = authorization.map_err(HyperlaneAleoError::SnarkVmError)?;

        // Malicious authorization check
        self.malicious_authorization_check(program_id, &authorization)?;

        debug!(
            "Prepared Authorization in {:.2}s",
            Instant::now().duration_since(start).as_secs_f32()
        );
        Ok((
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

    /// Returns a cached fee estimate without constructing transaction inputs.
    pub async fn cached_fee_estimate(
        &self,
        program_id: &str,
        function_name: &str,
    ) -> Option<FeeEstimate> {
        let key = FeeEstimateCacheKey {
            program_id: program_id.to_string(),
            function_name: function_name.to_string(),
            network_id: self.chain_id(),
        };
        self.estimate_cache.read().await.get(&key).cloned()
    }

    /// Generic estimation function (no proving, no broadcast).
    pub async fn estimate<N: Network, A: Aleo<Network = N>, I, V>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
        vm: &VM<N, ConsensusMemory<N>>,
    ) -> ChainResult<FeeEstimate>
    where
        I: IntoIterator<Item = V>,
        I::IntoIter: ExactSizeIterator,
        V: TryInto<Value<N>> + Send + 'static,
    {
        let (authorization, program_id_parsed, function_name_parsed, _, _) = self
            .prepare_authorization::<N, A, I, V>(
                program_id,
                function_name,
                input,
                vm,
                self.proving_service.is_some(),
            )
            .await?;
        let base = self
            .calculate_function_costs::<N>(
                vm,
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
        let key = FeeEstimateCacheKey {
            program_id: program_id.to_string(),
            function_name: function_name.to_string(),
            network_id: self.chain_id(),
        };

        {
            let cache = self.estimate_cache.read().await;
            let result = cache.get(&key);

            if let Some(cached) = result {
                debug!(
                    "Using cached fee estimate for {program_id}/{function_name} on network {}",
                    self.chain_id()
                );
                return Ok(cached.clone());
            }
        }

        let result = match self.chain_id() {
            0 => {
                self.estimate::<MainnetV0, AleoV0, _, _>(
                    program_id,
                    function_name,
                    input,
                    get_vm(&self.mainnet_vm).await?,
                )
                .await
            }
            1 => {
                self.estimate::<TestnetV0, AleoTestnetV0, _, _>(
                    program_id,
                    function_name,
                    input,
                    get_vm(&self.testnet_vm).await?,
                )
                .await
            }
            2 => {
                self.estimate::<CanaryV0, AleoCanaryV0, _, _>(
                    program_id,
                    function_name,
                    input,
                    get_vm(&self.canary_vm).await?,
                )
                .await
            }
            id => Err(HyperlaneAleoError::UnknownNetwork(id).into()),
        }?;

        let mut cache = self.estimate_cache.write().await;
        cache.insert(key, result.clone());

        Ok(result)
    }

    /// Executes the transaction for the given network
    async fn execute<N: Network, A: Aleo<Network = N>, I, V>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
        vm: &VM<N, ConsensusMemory<N>>,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = V>,
        I::IntoIter: ExactSizeIterator,
        V: TryInto<Value<N>> + Send + 'static,
    {
        debug!("Creating ZK-Proof for: {}/{}", program_id, function_name);

        // Prepare VM + Authorization for execution.
        let authorization_start = Instant::now();
        let authorization = self
            .prepare_authorization::<N, A, I, V>(
                program_id,
                function_name,
                input,
                vm,
                self.proving_service.is_some(),
            )
            .await;
        record_execution_phase(
            &self.execution_metrics,
            &self.execution_metrics_config,
            ExecutionPhase::Authorization,
            authorization_start,
            authorization.is_ok(),
        );
        let (authorization, program_id_parsed, function_name_parsed, private_key, mut rng) =
            authorization?;

        // Calculate fees
        let base_fee = self
            .calculate_function_costs::<N>(
                vm,
                &authorization,
                &program_id_parsed,
                &function_name_parsed,
            )
            .await?;
        let priority_fee = self.get_priority_fee(base_fee);
        debug!(base_fee, priority_fee, "Calculated fees");

        // Authorize fee payment. Delegated proving only needs the evaluated
        // transition; the prover checks its circuit while generating the proof.
        let execution_id = authorization
            .to_execution_id()
            .map_err(HyperlaneAleoError::from)?;
        let fee_authorization_start = Instant::now();
        let delegated = self.proving_service.is_some();
        let credits_program =
            ProgramID::<N>::from_str("credits.aleo").map_err(HyperlaneAleoError::SnarkVmError)?;
        let fee_public =
            Identifier::<N>::from_str("fee_public").map_err(HyperlaneAleoError::SnarkVmError)?;
        let job_vm = vm.clone();
        let (fee, mut rng) = vm_thread::run(move || {
            let fee = if delegated {
                job_vm
                    .process()
                    .authorize_unchecked::<A, _>(
                        &private_key,
                        credits_program,
                        fee_public,
                        [
                            format!("{base_fee}u64"),
                            format!("{priority_fee}u64"),
                            execution_id.to_string(),
                        ]
                        .into_iter(),
                        &mut rng,
                    )
                    .map_err(|error| HyperlaneAleoError::SnarkVmError(error.into()))
            } else {
                job_vm
                    .authorize_fee_public(
                        &private_key,
                        base_fee,
                        priority_fee,
                        execution_id,
                        &mut rng,
                    )
                    .map_err(HyperlaneAleoError::SnarkVmError)
            };
            (fee, rng)
        })
        .await?;
        record_execution_phase(
            &self.execution_metrics,
            &self.execution_metrics_config,
            ExecutionPhase::FeeAuthorization,
            fee_authorization_start,
            fee.is_ok(),
        );
        let fee = fee?;

        // Use local proving only when no delegated proving service is configured. A delegated
        // prover failure is retried by the relayer; falling back here can saturate Tokio's
        // blocking pool and destabilize unrelated chains.
        let start = Instant::now();
        let transaction = match self.proving_service {
            Some(ref client) => {
                debug!(
                    program_id,
                    function_name, "Starting delegated ZK proof generation"
                );
                let proof_start = Instant::now();
                let proof = client.proving_request(authorization, fee).await;
                record_execution_phase(
                    &self.execution_metrics,
                    &self.execution_metrics_config,
                    ExecutionPhase::DelegatedProverProof,
                    proof_start,
                    proof.is_ok(),
                );
                proof.map_err(|error| {
                    warn!(%error, "Delegated proving failed");
                    error
                })?
            }
            None => {
                debug!(
                    program_id,
                    function_name, "Starting local ZK proof generation"
                );
                vm.execute_authorization(authorization, Some(fee), Some(&self.client), &mut rng)
                    .map_err(HyperlaneAleoError::from)?
            }
        };

        let elapsed = start.elapsed();
        debug!(
            elapsed_secs = elapsed.as_secs_f32(),
            program_id, function_name, "ZK proof generation complete"
        );

        let id = transaction.id();
        debug!(tx_id = %id, "Broadcasting Aleo transaction");
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
                self.execute::<MainnetV0, AleoV0, _, _>(
                    program_id,
                    function_name,
                    input,
                    get_vm(&self.mainnet_vm).await?,
                )
                .await
            }
            1 => {
                // Testnet
                self.execute::<TestnetV0, AleoTestnetV0, _, _>(
                    program_id,
                    function_name,
                    input,
                    get_vm(&self.testnet_vm).await?,
                )
                .await
            }
            2 => {
                // Canary
                self.execute::<CanaryV0, AleoCanaryV0, _, _>(
                    program_id,
                    function_name,
                    input,
                    get_vm(&self.canary_vm).await?,
                )
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
        const POLLING_INTERVAL: u64 = 1;
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
        let height = u32::try_from(height).map_err(ChainCommunicationError::from_other)?;
        if let Some(block) = self.block_metadata.read().await.get(&height) {
            return Ok(block.clone());
        }
        let block = match self.chain_id() {
            0 => self.fetch_block_metadata::<MainnetV0>(height).await?,
            1 => self.fetch_block_metadata::<TestnetV0>(height).await?,
            2 => self.fetch_block_metadata::<CanaryV0>(height).await?,
            id => return Err(HyperlaneAleoError::UnknownNetwork(id).into()),
        };
        let mut cache = self.block_metadata.write().await;
        cache.insert(height, block.clone());
        if cache.len() > BLOCK_METADATA_CACHE_SIZE {
            cache.pop_first();
        }
        Ok(block)
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
        Ok(Some(ChainInfo {
            block_height: height.into(),
            min_gas_price: None,
        }))
    }
}

#[cfg(test)]
mod vm_lifecycle_tests {
    use std::path::PathBuf;

    use hyperlane_core::KnownHyperlaneDomain;
    use snarkvm::utilities::rand::TestRng;
    use snarkvm_console_account::ToBytes;
    use url::Url;

    use super::*;
    use crate::provider::mock::MockHttpClient;

    fn domain() -> HyperlaneDomain {
        HyperlaneDomain::Known(KnownHyperlaneDomain::Aleo)
    }

    fn test_signer() -> AleoSigner {
        let private_key = PrivateKey::<CurrentNetwork>::new(&mut TestRng::default())
            .expect("private key fixture");
        AleoSigner::new(&private_key.to_bytes_le().expect("private key bytes"))
            .expect("signer fixture")
    }

    fn execution_provider() -> AleoProvider<MockHttpClient> {
        let base_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/provider/mock_responses");
        let client = MockHttpClient::new(base_path);
        client
            .register_file("program/credits.aleo/0", "programs/credits.aleo")
            .expect("credits program fixture");
        client.register_value("program/credits.aleo/latest_edition", serde_json::json!(0));
        AleoProvider::with_client(client, domain(), 0, Some(test_signer()))
    }

    #[tokio::test]
    #[ignore = "manual authorization performance benchmark"]
    async fn benchmark_checked_vs_unchecked_authorization() {
        const RECIPIENT: &str = "aleo1qkjr490qe7p9v45qrd5pjemmqn4vmgqt8vzc8j0jfwhc7mf5f5zqly7vze";
        const RUNS: usize = 5;

        let provider = execution_provider();
        let vm = get_vm(&provider.mainnet_vm).await.expect("mainnet VM");

        let mut timings = Vec::new();
        for unchecked in [false, true] {
            let mut elapsed = Vec::with_capacity(RUNS);
            let mut transition_count = None;
            for _ in 0..RUNS {
                let start = Instant::now();
                let (authorization, ..) = provider
                    .prepare_authorization::<MainnetV0, AleoV0, _, _>(
                        "credits.aleo",
                        "transfer_public",
                        [RECIPIENT.to_owned(), "5u64".to_owned()],
                        vm,
                        unchecked,
                    )
                    .await
                    .expect("authorization");
                elapsed.push(start.elapsed());
                let count = authorization.transitions().len();
                assert_eq!(*transition_count.get_or_insert(count), count);
            }
            elapsed.sort_unstable();
            timings.push((unchecked, elapsed[RUNS / 2], transition_count.unwrap()));
        }

        let checked = timings[0].1;
        let unchecked = timings[1].1;
        assert_eq!(timings[0].2, timings[1].2);
        eprintln!(
            "authorization benchmark: checked={checked:?}, unchecked={unchecked:?}, speedup={:.2}x, transitions={}",
            checked.as_secs_f64() / unchecked.as_secs_f64(),
            timings[0].2,
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "manual mainnet authorization performance benchmark"]
    async fn benchmark_mainnet_transfer_authorization() {
        const PROGRAM: &str = "hyp_warp_token_eth_v2.aleo";
        const FUNCTION: &str = "process";
        const TRANSACTION: &str = "at1l7e9m3ppacql2kd5sw0sarqmgdvxstuzptrnke6f64fgd3q7hqzssp7ajl";
        const RUNS: usize = 3;

        let rpc = Url::parse("https://api.explorer.provable.com/v2").expect("mainnet RPC URL");
        let transaction: serde_json::Value =
            reqwest::get(format!("{rpc}/mainnet/transaction/{TRANSACTION}"))
                .await
                .expect("fetch mainnet transaction")
                .json()
                .await
                .expect("parse mainnet transaction");
        let transition = transaction["execution"]["transitions"]
            .as_array()
            .expect("execution transitions")
            .iter()
            .find(|transition| {
                transition["program"] == PROGRAM && transition["function"] == FUNCTION
            })
            .expect("entry transition");
        let inputs = transition["inputs"]
            .as_array()
            .expect("transition inputs")
            .iter()
            .map(|input| {
                input["value"]
                    .as_str()
                    .expect("public transition input")
                    .to_owned()
            })
            .collect::<Vec<_>>();

        let conf = ConnectionConf::new(
            vec![rpc],
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            0,
            None,
            vec![],
            0.0,
        );
        let provider = AleoProvider::new(
            &conf,
            domain(),
            Some(test_signer()),
            Default::default(),
            None,
        )
        .expect("mainnet provider");
        let vm = get_vm(&provider.mainnet_vm).await.expect("mainnet VM");
        provider
            .load_program(vm, &PROGRAM.parse().expect("program ID"), 0)
            .await
            .expect("load production programs");

        let mut timings = Vec::new();
        for unchecked in [false, true] {
            let mut elapsed = Vec::with_capacity(RUNS);
            let mut transition_count = None;
            for _ in 0..RUNS {
                let start = Instant::now();
                let (authorization, ..) = provider
                    .prepare_authorization::<MainnetV0, AleoV0, _, _>(
                        PROGRAM,
                        FUNCTION,
                        inputs.clone(),
                        vm,
                        unchecked,
                    )
                    .await
                    .expect("authorization");
                elapsed.push(start.elapsed());
                let count = authorization.transitions().len();
                assert_eq!(*transition_count.get_or_insert(count), count);
            }
            elapsed.sort_unstable();
            timings.push((unchecked, elapsed[RUNS / 2], transition_count.unwrap()));
        }

        let checked = timings[0].1;
        let unchecked = timings[1].1;
        assert_eq!(timings[0].2, timings[1].2);
        eprintln!(
            "mainnet authorization benchmark: checked={checked:?}, unchecked={unchecked:?}, speedup={:.2}x, transitions={}",
            checked.as_secs_f64() / unchecked.as_secs_f64(),
            timings[0].2,
        );

        let (authorization, _, _, private_key, mut rng) = provider
            .prepare_authorization::<MainnetV0, AleoV0, _, _>(PROGRAM, FUNCTION, inputs, vm, true)
            .await
            .expect("execution authorization");
        let execution_id = authorization.to_execution_id().expect("execution ID");
        let execution_id_input = execution_id.to_string();
        let credits_program =
            ProgramID::<MainnetV0>::from_str("credits.aleo").expect("credits program ID");
        let fee_public = Identifier::<MainnetV0>::from_str("fee_public").expect("fee function");
        let mut fee_timings = Vec::new();
        for unchecked in [false, true] {
            let mut elapsed = Vec::with_capacity(RUNS);
            let mut transition_count = None;
            for _ in 0..RUNS {
                let start = Instant::now();
                let fee = if unchecked {
                    vm.process()
                        .authorize_unchecked::<AleoV0, _>(
                            &private_key,
                            credits_program,
                            fee_public,
                            ["1000000u64", "0u64", execution_id_input.as_str()].into_iter(),
                            &mut rng,
                        )
                        .expect("unchecked fee authorization")
                } else {
                    vm.authorize_fee_public(&private_key, 1_000_000, 0, execution_id, &mut rng)
                        .expect("checked fee authorization")
                };
                elapsed.push(start.elapsed());
                let count = fee.transitions().len();
                assert_eq!(*transition_count.get_or_insert(count), count);
            }
            elapsed.sort_unstable();
            fee_timings.push((unchecked, elapsed[RUNS / 2], transition_count.unwrap()));
        }

        let checked_fee = fee_timings[0].1;
        let unchecked_fee = fee_timings[1].1;
        assert_eq!(fee_timings[0].2, fee_timings[1].2);
        eprintln!(
            "mainnet fee authorization benchmark: checked={checked_fee:?}, unchecked={unchecked_fee:?}, speedup={:.2}x, transitions={}",
            checked_fee.as_secs_f64() / unchecked_fee.as_secs_f64(),
            fee_timings[0].2,
        );

        let fee = vm
            .process()
            .authorize_unchecked::<AleoV0, _>(
                &private_key,
                credits_program,
                fee_public,
                ["1000000u64", "0u64", execution_id_input.as_str()].into_iter(),
                &mut rng,
            )
            .expect("unchecked fee authorization");
        let proof_start = Instant::now();
        vm.execute_authorization(authorization, Some(fee), Some(&provider.client), &mut rng)
            .expect("prove unchecked authorizations");
        eprintln!(
            "mainnet unchecked authorization local proof: {:?}",
            proof_start.elapsed()
        );
    }

    #[test]
    fn production_providers_do_not_start_vms() {
        let conf = ConnectionConf::new(
            vec!["http://localhost:3030".parse().expect("valid RPC URL")],
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            0,
            None,
            vec![],
            0.0,
        );
        for _ in 0..4 {
            let provider = AleoProvider::new(&conf, domain(), None, Default::default(), None)
                .expect("test fixture succeeds");
            assert!(provider.mainnet_vm.get().is_none());
            assert!(provider.testnet_vm.get().is_none());
            assert!(provider.canary_vm.get().is_none());
        }
    }

    #[tokio::test]
    async fn read_only_queries_do_not_start_vms() {
        let client = MockHttpClient::new(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/provider/mock_responses"),
        );
        client
            .register_file("block/height/latest", "latest_height.json")
            .expect("test fixture succeeds");
        let provider = AleoProvider::with_client(client, domain(), 0, None);
        assert_eq!(
            provider
                .get_latest_height()
                .await
                .expect("test fixture succeeds"),
            1
        );
        assert!(provider.mainnet_vm.get().is_none());
        assert!(provider.testnet_vm.get().is_none());
        assert!(provider.canary_vm.get().is_none());
    }

    #[test]
    fn first_use_waits_for_blocking_pool_and_shares_initialized_vm() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .expect("test runtime")
            .block_on(async {
                // Occupy the sole blocking thread so initialization cannot complete
                // until both callers have yielded back to this runtime thread.
                let (started_tx, started_rx) = tokio::sync::oneshot::channel();
                let (release_tx, release_rx) = std::sync::mpsc::channel();
                let blocker = tokio::task::spawn_blocking(move || {
                    let _ = started_tx.send(());
                    let _ = release_rx.recv();
                });
                started_rx.await.expect("blocking task started");
                let client = MockHttpClient::new(PathBuf::new());
                let provider = AleoProvider::with_client(client, domain(), 0, None);
                let clone = provider.clone();
                let first = get_vm(&provider.mainnet_vm);
                let second = get_vm(&clone.mainnet_vm);
                tokio::pin!(first, second);
                let first_pending = futures::poll!(first.as_mut()).is_pending();
                let second_pending = futures::poll!(second.as_mut()).is_pending();
                let uninitialized = provider.mainnet_vm.get().is_none();
                // Release before asserting so a failed assertion cannot strand
                // the blocking task during runtime shutdown.
                release_tx.send(()).expect("release blocking task");
                assert!(first_pending && second_pending && uninitialized);
                let (first, second) = tokio::join!(first, second);
                assert!(std::ptr::eq(
                    first.expect("initialized VM"),
                    second.expect("shared VM")
                ));
                assert!(provider.testnet_vm.get().is_none());
                assert!(provider.canary_vm.get().is_none());
                blocker.await.expect("blocking task finished");
            });
    }

    #[tokio::test]
    async fn provider_clones_share_only_the_initialized_network_vm() {
        let client = MockHttpClient::new(PathBuf::new());
        let provider = AleoProvider::with_client(client, domain(), 0, None);
        let clone = provider.clone();
        let (first, second) =
            tokio::join!(get_vm(&provider.mainnet_vm), get_vm(&clone.mainnet_vm),);
        assert!(std::ptr::eq(
            first.expect("test fixture succeeds"),
            second.expect("test fixture succeeds")
        ));
        assert!(provider.testnet_vm.get().is_none());
        assert!(provider.canary_vm.get().is_none());
        assert!(clone.testnet_vm.get().is_none());
        assert!(clone.canary_vm.get().is_none());

        let process = Arc::downgrade(provider.mainnet_vm.get().expect("initialized VM").process());
        drop(provider);
        assert!(process.upgrade().is_some());
        drop(clone);
        assert!(
            process.upgrade().is_none(),
            "worker retained the final provider VM"
        );
    }
}
