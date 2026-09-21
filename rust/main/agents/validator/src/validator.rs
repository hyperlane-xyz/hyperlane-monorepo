use std::{fmt::Debug, sync::Arc, time::Duration};

use async_trait::async_trait;
use axum::Router;
use derive_more::AsRef;
use ethers::utils::keccak256;
use eyre::{eyre, Context, Result};
use futures_util::future::try_join_all;
use rand::Rng;
use serde::Serialize;
use tokio::{
    sync::Notify,
    task::JoinHandle,
    time::{sleep, Instant},
};
use tracing::{error, info, info_span, warn, Instrument};
use url::Url;

use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB, DB},
    git_sha,
    metrics::AgentMetrics,
    settings::{ChainConf, CheckpointSyncerBuildError},
    BaseAgent, ChainMetrics, ChainSpecificMetricsUpdater, CheckpointSyncer, ContractSyncMetrics,
    ContractSyncer, CoreMetrics, HyperlaneAgentCore, MetadataFromSettings, RuntimeMetrics,
    SequencedDataContractSync,
};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, rpc_clients::RPC_RETRY_SLEEP_DURATION,
    Announcement, ChainResult, CheckpointAtBlock, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneSigner, HyperlaneSignerExt, IncrementalMerkleAtBlock, MerkleTreeHook,
    MerkleTreeInsertion, ReorgPeriod, TxOutcome, ValidatorAnnounce, ValidatorAnnounceSubmission,
    H256, U256,
};
use hyperlane_ethereum::{Signers, SingletonSigner, SingletonSignerHandle};
use hyperlane_metric::{
    prometheus_metric::RpcRole,
    rpc_operation::{with_rpc_operation, RpcOperation},
};

use crate::checkpoint_consensus::CheckpointReader;
use crate::merkle_tree_hook_sync::{
    merkle_tree_cursor_state, CheckpointingMerkleTreeStore, MerkleTreeHookWebSocketSync,
    MerkleTreeRpcRecovery,
};
use crate::reorg_reporter::{
    LatestCheckpointReorgReporter, LatestCheckpointReorgReporterWithStorageWriter, ReorgReporter,
};
use crate::rpc::{build_validator_per_url_hooks, dedupe_rpc_urls, state_read_urls};
use crate::server::{self as validator_server, merkle_tree_insertions, ValidatorReadiness};
use crate::{
    settings::ValidatorSettings,
    submit::{ValidatorSubmitter, ValidatorSubmitterMetrics},
};

const CURSOR_INSTANTIATION_ATTEMPTS: usize = 10;

#[derive(Debug)]
enum MerkleTreeHookSync {
    Rpc(Arc<SequencedDataContractSync<MerkleTreeInsertion>>),
    WebSocket {
        fallback: Option<Arc<SequencedDataContractSync<MerkleTreeInsertion>>>,
        websocket: Box<MerkleTreeHookWebSocketSync>,
    },
}

const ANNOUNCEMENT_RETRY_MIN_DELAY: Duration = Duration::from_secs(30);
const ANNOUNCEMENT_RETRY_MAX_DELAY: Duration = Duration::from_secs(900);
const ANNOUNCEMENT_FUNDING_POLL_INTERVAL: Duration = Duration::from_secs(30);
const ANNOUNCEMENT_RETRY_MIN_JITTER_PERMILLE: u32 = 800;
const ANNOUNCEMENT_RETRY_MAX_JITTER_PERMILLE: u32 = 1000;

/// Keeps announcement submission and unfunded warnings off the validator's hot poll loop while
/// still allowing that loop to observe funding and on-chain announcement progress promptly.
#[derive(Debug, Default)]
struct AnnouncementRetryBackoff {
    consecutive_failures: u32,
    next_attempt_at: Option<Instant>,
    next_funding_check_at: Option<Instant>,
    last_tokens_needed: Option<U256>,
    consecutive_unfunded_observations: u8,
    funding_reset_armed: bool,
    submission_in_flight: bool,
}

impl AnnouncementRetryBackoff {
    fn ready(&self, now: Instant) -> bool {
        !self.submission_in_flight
            && self
                .next_attempt_at
                .is_none_or(|next_attempt_at| now >= next_attempt_at)
    }

    fn next_failure_delay(&self) -> Duration {
        let multiplier = 2_u32.saturating_pow(self.consecutive_failures.min(31));
        ANNOUNCEMENT_RETRY_MIN_DELAY
            .saturating_mul(multiplier)
            .min(ANNOUNCEMENT_RETRY_MAX_DELAY)
    }

    fn funding_check_due(&self, now: Instant) -> bool {
        self.next_funding_check_at
            .is_none_or(|next_funding_check_at| now >= next_funding_check_at)
    }

    /// Poll funding between attempts only when the last successful preflight proved the signer is
    /// unfunded. If preflight is unavailable (for example, an RPC does not support `feeHistory`),
    /// retrying it on a separate timer cannot detect funding and only creates more failed calls.
    fn should_check_funding(&self, now: Instant) -> bool {
        if self.submission_in_flight {
            return false;
        }

        self.ready(now)
            || (self
                .last_tokens_needed
                .is_some_and(|tokens_needed| !tokens_needed.is_zero())
                && self.funding_check_due(now))
    }

    fn record_funding_check(&mut self, now: Instant) {
        self.next_funding_check_at = now.checked_add(ANNOUNCEMENT_FUNDING_POLL_INTERVAL);
    }

    fn jittered(delay: Duration, jitter_permille: u32) -> Duration {
        let bounded_jitter = jitter_permille.clamp(
            ANNOUNCEMENT_RETRY_MIN_JITTER_PERMILLE,
            ANNOUNCEMENT_RETRY_MAX_JITTER_PERMILLE,
        );
        let millis = delay
            .as_millis()
            .saturating_mul(u128::from(bounded_jitter))
            .checked_div(u128::from(ANNOUNCEMENT_RETRY_MAX_JITTER_PERMILLE))
            .unwrap_or_default();
        Duration::from_millis(u64::try_from(millis).unwrap_or(u64::MAX))
    }

    fn record_failure(&mut self, now: Instant, delay: Duration) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        self.next_attempt_at = now.checked_add(delay);
    }

    fn mark_submission_in_flight(&mut self) {
        self.consecutive_failures = 0;
        self.next_attempt_at = None;
        self.submission_in_flight = true;
    }

    /// A transition to a preflight-confirmed funded state is actionable progress: allow an
    /// immediate attempt even if earlier failures were cooling down. Missing preflight data does
    /// not erase the last known state, preventing intermittent RPC errors from defeating backoff.
    fn observe_tokens_needed(&mut self, tokens_needed: Option<U256>) -> bool {
        let Some(tokens_needed) = tokens_needed else {
            return false;
        };

        let became_funded = if tokens_needed.is_zero() {
            self.consecutive_unfunded_observations = 0;
            let became_funded = self.funding_reset_armed;
            self.funding_reset_armed = false;
            became_funded
        } else {
            self.consecutive_unfunded_observations =
                self.consecutive_unfunded_observations.saturating_add(1);
            if self.consecutive_unfunded_observations >= 2 {
                self.funding_reset_armed = true;
            }
            false
        };
        self.last_tokens_needed = Some(tokens_needed);
        if became_funded {
            self.consecutive_failures = 0;
            self.next_attempt_at = None;
        }
        became_funded
    }

    /// Use the last successful preflight result when the current preflight is unavailable. In
    /// particular, a transient estimation failure must not turn a known-unfunded signer into a
    /// submission attempt.
    fn effective_tokens_needed(&self, current: Option<U256>) -> Option<U256> {
        current.or(self.last_tokens_needed)
    }
}

/// Connects safety-critical MerkleTreeHook reads to the validator readiness endpoint. An empty
/// tree is an expected ready state because there is nothing to sign. Once a tree exists, any
/// failed correctness read blocks signing and readiness until a later read succeeds.
#[derive(Debug)]
struct ReadinessMerkleTreeHook {
    inner: Arc<dyn MerkleTreeHook>,
    readiness: Arc<ValidatorReadiness>,
    source: &'static str,
}

impl ReadinessMerkleTreeHook {
    fn new(
        inner: Arc<dyn MerkleTreeHook>,
        readiness: Arc<ValidatorReadiness>,
        source: &'static str,
    ) -> Self {
        Self {
            inner,
            readiness,
            source,
        }
    }

    fn operation(&self, operation: &str) -> String {
        format!("{}.{}", self.source, operation)
    }

    fn record_checkpoint_read<T>(&self, operation: &str, result: &ChainResult<T>) {
        let operation = self.operation(operation);
        match result {
            Ok(_) => self.readiness.mark_operation_ready(&operation),
            Err(_) => {
                let snapshot = self.readiness.mark_operation_blocked(&operation);
                warn!(
                    operation = operation.as_str(),
                    consecutive_failures = snapshot.consecutive_failures,
                    failure_duration_ms = snapshot.failure_duration_ms,
                    signing_blocked = snapshot.signing_blocked,
                    "Validator checkpoint production is blocked"
                );
            }
        }
    }

    fn record_count(&self, result: &ChainResult<u32>) {
        let operation = self.operation("count");
        match result {
            Ok(_) => self.readiness.mark_operation_ready(&operation),
            Err(_) => {
                let snapshot = self.readiness.mark_operation_blocked(&operation);
                warn!(
                    operation = operation.as_str(),
                    consecutive_failures = snapshot.consecutive_failures,
                    failure_duration_ms = snapshot.failure_duration_ms,
                    signing_blocked = snapshot.signing_blocked,
                    "Validator checkpoint production is blocked"
                );
            }
        }
    }
}

#[async_trait]
impl MerkleTreeHook for ReadinessMerkleTreeHook {
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        let result = self.inner.tree(reorg_period).await;
        self.record_checkpoint_read("tree", &result);
        result
    }

    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let result = self.inner.count(reorg_period).await;
        self.record_count(&result);
        result
    }

    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        let result = self.inner.latest_checkpoint(reorg_period).await;
        self.record_checkpoint_read("latest_checkpoint", &result);
        result
    }

    async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock> {
        let result = self.inner.latest_checkpoint_at_block(height).await;
        self.record_checkpoint_read("latest_checkpoint_at_block", &result);
        result
    }
}

impl HyperlaneChain for ReadinessMerkleTreeHook {
    fn domain(&self) -> &HyperlaneDomain {
        self.inner.domain()
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        self.inner.provider()
    }
}

impl HyperlaneContract for ReadinessMerkleTreeHook {
    fn address(&self) -> H256 {
        self.inner.address()
    }
}

async fn wait_for_first_message(
    merkle_tree_hook: Arc<dyn MerkleTreeHook>,
    reorg_period: &ReorgPeriod,
    interval: Duration,
    readiness: &ValidatorReadiness,
) -> IncrementalMerkleAtBlock {
    loop {
        match merkle_tree_hook.count(reorg_period).await {
            Err(_) => {
                error!("Error getting merkle tree count");
            }
            Ok(0) => {
                readiness.mark_waiting_for_first_message();
                info!("Waiting for first message in merkle tree hook");
            }
            Ok(_) => match merkle_tree_hook.tree(reorg_period).await {
                Err(_) => {
                    error!("Error getting merkle tree");
                }
                Ok(tree) if tree.count() == 0 => {
                    readiness.mark_waiting_for_first_message();
                    info!("Waiting for first message in merkle tree hook");
                }
                Ok(tree) => return tree,
            },
        }
        sleep(interval).await;
    }
}

/// A validator agent
#[derive(Debug, AsRef)]
pub struct Validator {
    origin_chain: HyperlaneDomain,
    origin_chain_conf: ChainConf,
    #[as_ref]
    core: HyperlaneAgentCore,
    db: HyperlaneRocksDB,
    merkle_tree_hook_sync: MerkleTreeHookSync,
    checkpoint_wake: Option<Arc<Notify>>,
    merkle_tree_hook: Arc<dyn MerkleTreeHook>,
    readiness: Arc<ValidatorReadiness>,
    signer: SingletonSignerHandle,
    raw_signer: Signers,
    // temporary holder until `run` is called
    signer_instance: Option<Box<SingletonSigner>>,
    reorg_period: ReorgPeriod,
    interval: Duration,
    checkpoint_syncer: Arc<dyn CheckpointSyncer>,
    core_metrics: Arc<CoreMetrics>,
    agent_metrics: AgentMetrics,
    chain_metrics: ChainMetrics,
    runtime_metrics: RuntimeMetrics,
    agent_metadata: ValidatorMetadata,
    max_sign_concurrency: usize,
    reorg_reporter: Option<Arc<dyn ReorgReporter>>,
    skip_announce: bool,
    checkpoint_reader: Option<Arc<CheckpointReader>>,
}

/// Metadata for `validator`
#[derive(Debug, Serialize)]
pub struct ValidatorMetadata {
    git_sha: String,
    rpcs: Vec<ValidatorMetadataRpcEntry>,
    allows_public_rpcs: bool,
}
#[derive(Debug, Serialize)]
pub struct ValidatorMetadataRpcEntry {
    url_hash: H256,
    host_hash: H256,
}

impl ValidatorMetadataRpcEntry {
    fn hash_rpc(rpc: &crate::settings::RpcConfig) -> Self {
        Self {
            url_hash: H256::from_slice(&keccak256(&rpc.url)),
            host_hash: H256::from_slice(&keccak256(
                Url::parse(&rpc.url)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_string))
                    .unwrap_or("".to_string()),
            )),
        }
    }
}

impl MetadataFromSettings<ValidatorSettings> for ValidatorMetadata {
    /// Create a new instance of the agent metadata from the settings
    fn build_metadata(settings: &ValidatorSettings) -> ValidatorMetadata {
        // Hash all the RPCs for the metadata
        let rpcs = settings
            .rpcs
            .iter()
            .map(ValidatorMetadataRpcEntry::hash_rpc)
            .collect();
        ValidatorMetadata {
            git_sha: git_sha(),
            rpcs,
            allows_public_rpcs: settings.allow_public_rpcs,
        }
    }
}

#[async_trait]
impl BaseAgent for Validator {
    const AGENT_NAME: &'static str = "validator";

    type Settings = ValidatorSettings;
    type Metadata = ValidatorMetadata;

    async fn from_settings(
        agent_metadata: Self::Metadata,
        settings: Self::Settings,
        metrics: Arc<CoreMetrics>,
        agent_metrics: AgentMetrics,
        chain_metrics: ChainMetrics,
        runtime_metrics: RuntimeMetrics,
        _tokio_console_server: console_subscriber::Server,
    ) -> Result<Self>
    where
        Self: Sized,
    {
        let public_rpc_urls: Vec<String> = settings
            .rpcs
            .iter()
            .filter_map(|x| if x.public { Some(x.url.clone()) } else { None })
            .collect();
        if !public_rpc_urls.is_empty() && !settings.allow_public_rpcs {
            return Err(
                eyre!(
                    "Public RPC endpoints detected: {}. Using public RPCs can compromise security and reliability. If you understand the risks and still want to proceed, set `--allowPublicRpcs true`. We strongly recommend using private RPC endpoints for production validators.",
                    public_rpc_urls.join(", ")
                )
            );
        }

        let db = DB::from_path(&settings.db)?;
        let msg_db = HyperlaneRocksDB::new(&settings.origin_chain, db);

        let raw_signer: Signers = settings.validator.build().await?;

        // Intentionally using hyperlane_ethereum for the validator's signer
        let (signer_instance, signer) = SingletonSigner::new(raw_signer.clone());

        let core = settings.build_hyperlane_core(metrics.clone());

        let reorg_reporter = if settings.lightweight {
            None
        } else {
            Some(LatestCheckpointReorgReporter::from_settings(&settings, &metrics).await?)
        };

        let checkpoint_syncer_result = settings.checkpoint_syncer.build_and_validate(None).await;

        if let Some(reorg_reporter) = &reorg_reporter {
            Self::report_latest_checkpoints_from_each_endpoint(
                reorg_reporter,
                &checkpoint_syncer_result,
            )
            .await;
        }

        // Be extra sure to panic when checkpoint syncer fails, which indicates
        // a fatal startup error.
        let checkpoint_syncer: Arc<dyn CheckpointSyncer> = checkpoint_syncer_result
            .expect("Failed to build checkpoint syncer")
            .into();

        // If checkpoint syncer initialization was successful, use a reorg-reporter which
        // writes to the storage location in addition to the logs.
        let reorg_reporter = reorg_reporter.map(|reporter| {
            Arc::new(LatestCheckpointReorgReporterWithStorageWriter::new(
                reporter,
                checkpoint_syncer.clone(),
            )) as Arc<dyn ReorgReporter>
        });

        let origin_chain_conf = core.settings.chain_setup(&settings.origin_chain)?.clone();
        let (raw_merkle_tree_hook, checkpoint_reader): (
            Arc<dyn MerkleTreeHook>,
            Option<Arc<CheckpointReader>>,
        ) = if let Some(consensus) = settings.checkpoint_consensus {
            let rpc_urls = settings
                .rpcs
                .iter()
                .enumerate()
                .map(|(i, rpc)| Url::parse(&rpc.url).map_err(|_| eyre!("Invalid rpcUrls[{i}] URL")))
                .collect::<Result<Vec<_>>>()?;
            let (source, urls) = state_read_urls(&origin_chain_conf, rpc_urls)?;
            let urls = dedupe_rpc_urls(urls, source);
            let hooks = build_validator_per_url_hooks(
                &origin_chain_conf,
                source,
                RpcRole::Primary,
                &urls,
                &metrics,
            )
            .await?;
            let hooks: Vec<Arc<dyn MerkleTreeHook>> =
                hooks.into_iter().map(|(_, hook)| hook).collect();
            let first = hooks.first().cloned().ok_or_else(|| {
                eyre!("Checkpoint consensus requires at least one state-read endpoint")
            })?;
            let reader = Arc::new(CheckpointReader::new(consensus, hooks)?);
            let hook = if settings.lightweight {
                first
            } else {
                Arc::from(
                    settings
                        .build_merkle_tree_hook(&settings.origin_chain, &metrics)
                        .await?,
                )
            };
            (hook, Some(reader))
        } else {
            (
                settings
                    .build_merkle_tree_hook(&settings.origin_chain, &metrics)
                    .await?
                    .into(),
                None,
            )
        };
        let readiness = Arc::new(ValidatorReadiness::default());
        let merkle_tree_hook: Arc<dyn MerkleTreeHook> = Arc::new(ReadinessMerkleTreeHook::new(
            raw_merkle_tree_hook,
            Arc::clone(&readiness),
            "merkle_tree_hook",
        ));

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));
        let cursor_state = settings
            .websocket_url
            .as_ref()
            .map(|_| merkle_tree_cursor_state());
        let rpc_sync = if settings.lightweight {
            None
        } else {
            Some(if let Some(cursor_state) = cursor_state.clone() {
                settings
                    .sequenced_contract_sync::<MerkleTreeInsertion, _>(
                        &settings.origin_chain,
                        &metrics,
                        &contract_sync_metrics,
                        Arc::new(CheckpointingMerkleTreeStore::new(
                            msg_db.clone(),
                            cursor_state,
                        )),
                        false,
                        false,
                    )
                    .await?
            } else {
                settings
                    .sequenced_contract_sync::<MerkleTreeInsertion, _>(
                        &settings.origin_chain,
                        &metrics,
                        &contract_sync_metrics,
                        msg_db.clone().into(),
                        false,
                        false,
                    )
                    .await?
            })
        };
        let sync_source = metrics.new_int_gauge(
            "merkle_tree_hook_sync_source_active",
            "Whether a Merkle tree hook indexing source is active",
            &["origin", "source"],
        )?;
        let websocket_active =
            sync_source.with_label_values(&[settings.origin_chain.name(), "websocket"]);
        let rpc_active = sync_source.with_label_values(&[settings.origin_chain.name(), "rpc"]);
        let (merkle_tree_hook_sync, checkpoint_wake) =
            if let Some(url) = settings.websocket_url.clone() {
                let checkpoint_wake = Arc::new(Notify::new());
                (
                    MerkleTreeHookSync::WebSocket {
                        fallback: rpc_sync,
                        websocket: Box::new(MerkleTreeHookWebSocketSync::new_with_cursor_state(
                            msg_db.clone(),
                            settings.origin_chain.id(),
                            origin_chain_conf.addresses.merkle_tree_hook,
                            url,
                            websocket_active,
                            rpc_active,
                            cursor_state.expect("WebSocket configuration initializes cursor state"),
                            checkpoint_wake.clone(),
                        )),
                    },
                    Some(checkpoint_wake),
                )
            } else {
                websocket_active.set(0);
                rpc_active.set(1);
                (
                    MerkleTreeHookSync::Rpc(rpc_sync.expect("RPC mode builds an indexer")),
                    None,
                )
            };

        Ok(Self {
            origin_chain: settings.origin_chain,
            origin_chain_conf,
            core,
            db: msg_db,
            merkle_tree_hook,
            readiness,
            merkle_tree_hook_sync,
            checkpoint_wake,
            signer,
            raw_signer,
            signer_instance: Some(Box::new(signer_instance)),
            reorg_period: settings.reorg_period,
            interval: settings.interval,
            checkpoint_syncer,
            agent_metrics,
            chain_metrics,
            core_metrics: metrics,
            runtime_metrics,
            agent_metadata,
            max_sign_concurrency: settings.max_sign_concurrency,
            reorg_reporter,
            skip_announce: settings.skip_announce,
            checkpoint_reader,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(mut self) {
        let mut tasks = vec![];

        // run server
        let router = Router::new()
            .merge(validator_server::router(
                self.origin_chain.clone(),
                self.core.metrics.clone(),
                Arc::clone(&self.readiness),
            ))
            .merge(
                merkle_tree_insertions::list_merkle_tree_insertions::ServerState::new(
                    self.db.clone(),
                )
                .router(),
            );

        let server = self
            .core
            .settings
            .server(self.core_metrics.clone())
            .expect("Failed to create server");
        let server_task = tokio::spawn(
            async move {
                server.run_with_custom_router(router);
            }
            .instrument(info_span!("Validator server")),
        );
        tasks.push(server_task);

        if let Some(signer_instance) = self.signer_instance.take() {
            tasks.push(tokio::spawn(
                async move {
                    signer_instance.run().await;
                }
                .instrument(info_span!("SingletonSigner")),
            ));
        }

        let metrics_updater = match ChainSpecificMetricsUpdater::new(
            &self.origin_chain_conf,
            self.core_metrics.clone(),
            self.agent_metrics.clone(),
            self.chain_metrics.clone(),
            Self::AGENT_NAME.to_string(),
        )
        .await
        {
            Ok(task) => task,
            Err(err) => {
                tracing::error!(?err, "Failed to build metrics updater");
                return;
            }
        };

        // Checkpoint signing is off-chain. Announcement funding is checked on
        // demand by announce_tokens_needed, so no periodic balance reads are needed.
        let task = metrics_updater.without_wallet_balance().spawn();
        tasks.push(task);

        // report agent metadata
        self.metadata()
            .await
            .expect("Failed to report agent metadata");

        // announce the validator after spawning the signer task
        self.announce().await.expect("Failed to announce validator");

        let submitter = self.checkpoint_submitter();
        // Authenticate the snapshot before choosing the websocket replay cursor.
        let tip_tree = if self.checkpoint_reader.is_some() {
            self.readiness.mark_waiting_for_first_message();
            IncrementalMerkleAtBlock {
                tree: submitter.restore_consensus_tree().await,
                block_height: None,
            }
        } else {
            wait_for_first_message(
                Arc::clone(&self.merkle_tree_hook),
                &self.reorg_period,
                self.interval,
                &self.readiness,
            )
            .await
        };

        let backfill_tree = if self.checkpoint_reader.is_some() {
            tip_tree.tree.clone()
        } else {
            submitter
                .restored_snapshot_tree(tip_tree.index())
                .await
                .unwrap_or_default()
        };
        let replay_from = u32::try_from(backfill_tree.count()).expect("snapshot count fits in u32");

        let merkle_tree_hook_sync = match self
            .try_n_times_to_run_merkle_tree_hook_sync(
                CURSOR_INSTANTIATION_ATTEMPTS,
                tip_tree
                    .count()
                    .try_into()
                    .expect("Merkle tree leaf count must fit in u32"),
                replay_from,
            )
            .await
        {
            Ok(s) => s,
            Err(err) => {
                error!(?err, "Failed to run merkle tree hook sync");
                return;
            }
        };
        tasks.push(merkle_tree_hook_sync);
        for checkpoint_sync_task in self
            .run_checkpoint_submitters(submitter, tip_tree, backfill_tree)
            .await
        {
            tasks.push(checkpoint_sync_task);
        }

        tasks.push(self.runtime_metrics.spawn());

        // Note that this only returns an error if one of the tasks panics
        if let Err(err) = try_join_all(tasks).await {
            panic!("One of the validator tasks failed: {err}");
        }
    }
}

impl Validator {
    /// Try to create merkle tree hook contract sync attempts times before giving up.
    async fn try_n_times_to_run_merkle_tree_hook_sync(
        &self,
        attempts: usize,
        next_sequence_hint: u32,
        replay_from: u32,
    ) -> eyre::Result<JoinHandle<()>> {
        for i in 0..attempts {
            let task = match self
                .run_merkle_tree_hook_sync(next_sequence_hint, replay_from)
                .await
            {
                Ok(s) => s,
                Err(err) => {
                    error!(
                        ?err,
                        domain = self.origin_chain.name(),
                        attempt_count = i,
                        "Failed to run merkle tree hook sync"
                    );
                    sleep(RPC_RETRY_SLEEP_DURATION).await;
                    continue;
                }
            };
            self.chain_metrics
                .set_critical_error(self.origin_chain.name(), false);
            return Ok(task);
        }
        self.chain_metrics
            .set_critical_error(self.origin_chain.name(), true);
        Err(eyre::eyre!(
            "Failed to initialize merkle tree hook sync after {} attempts",
            attempts
        ))
    }

    async fn run_merkle_tree_hook_sync(
        &self,
        next_sequence_hint: u32,
        replay_from: u32,
    ) -> eyre::Result<JoinHandle<()>> {
        let origin = self.origin_chain.name().to_string();
        match &self.merkle_tree_hook_sync {
            MerkleTreeHookSync::Rpc(contract_sync) => {
                let index_settings = self
                    .as_ref()
                    .settings
                    .chains
                    .get(&self.origin_chain)
                    .map(|chain| chain.index_settings())
                    .ok_or_else(|| eyre::eyre!("No index setting found"))?;
                let contract_sync = contract_sync.clone();
                let cursor = contract_sync.cursor(index_settings).await?;
                Ok(tokio::spawn(
                    async move {
                        let label = "merkle_tree_hook";
                        contract_sync.clone().sync(label, cursor.into()).await;
                        info!(chain = origin, label, "contract sync task exit");
                    }
                    .instrument(info_span!("MerkleTreeHookSyncer")),
                ))
            }
            MerkleTreeHookSync::WebSocket {
                fallback,
                websocket,
            } => {
                let index_settings = self
                    .as_ref()
                    .settings
                    .chains
                    .get(&self.origin_chain)
                    .map(|chain| chain.index_settings())
                    .ok_or_else(|| eyre::eyre!("No index setting found"))?;
                let websocket = websocket.clone();
                let cursor_sync = websocket.clone();
                let next_sequence = tokio::task::spawn_blocking(move || {
                    cursor_sync.next_sequence_after_snapshot(replay_from)
                })
                .await
                .context("Finding the next Merkle tree insertion sequence")??;
                let fallback = fallback.clone();
                let merkle_tree_hook = self.merkle_tree_hook.clone();
                let reorg_period = self.reorg_period.clone();
                Ok(tokio::spawn(
                    async move {
                        websocket
                            .run(
                                next_sequence,
                                next_sequence_hint,
                                fallback,
                                index_settings,
                                merkle_tree_hook,
                                reorg_period,
                            )
                            .await
                    }
                    .instrument(info_span!("MerkleTreeHookWebSocketSyncer")),
                ))
            }
        }
    }

    fn checkpoint_submitter(&self) -> ValidatorSubmitter {
        ValidatorSubmitter::new(
            self.interval,
            self.reorg_period.clone(),
            self.merkle_tree_hook.clone(),
            self.signer.clone(),
            self.raw_signer.clone(),
            self.checkpoint_syncer.clone(),
            Arc::new(self.db.clone()) as Arc<dyn HyperlaneDb>,
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain),
            self.max_sign_concurrency,
            self.reorg_reporter.clone(),
            Arc::clone(&self.readiness),
        )
        .with_checkpoint_wake(self.checkpoint_wake.clone())
    }

    async fn run_checkpoint_submitters(
        &self,
        mut submitter: ValidatorSubmitter,
        tip_tree: IncrementalMerkleAtBlock,
        backfill_tree: IncrementalMerkle,
    ) -> Vec<JoinHandle<()>> {
        if let Some(reader) = &self.checkpoint_reader {
            let sync = match &self.merkle_tree_hook_sync {
                MerkleTreeHookSync::Rpc(sync) => Some(sync.clone()),
                MerkleTreeHookSync::WebSocket { fallback, .. } => fallback.clone(),
            };
            if let Some(sync) = sync {
                submitter = submitter.with_rpc_recovery(MerkleTreeRpcRecovery {
                    sync,
                    db: self.db.clone(),
                    index_settings: self.origin_chain_conf.index_settings(),
                    // Endpoint block metadata is not authenticated by a root vote.
                    from_block: None,
                });
            }
            let reader = reader.clone();
            return vec![tokio::spawn(
                async move {
                    with_rpc_operation(
                        RpcOperation::ValidatorCheckpoint,
                        submitter.consensus_checkpoint_submitter(reader, tip_tree.tree),
                    )
                    .await
                }
                .instrument(info_span!("ConsensusCheckpointSubmitter")),
            )];
        }

        // `wait_for_first_message` only returns a non-empty, quorum-verified tree.
        assert!(tip_tree.count() > 0, "merkle tree is empty");
        let backfill_target = submitter.checkpoint_at_block(&tip_tree);

        let mut backfill_submitter = submitter.clone();

        if let MerkleTreeHookSync::WebSocket {
            fallback: Some(fallback),
            ..
        } = &self.merkle_tree_hook_sync
        {
            let mut recovery = MerkleTreeRpcRecovery {
                sync: fallback.clone(),
                db: self.db.clone(),
                index_settings: self.core.settings.chains[&self.origin_chain].index_settings(),
                from_block: None,
            };
            backfill_submitter = backfill_submitter.with_rpc_recovery(recovery.clone());
            recovery.from_block = tip_tree.block_height;
            submitter = submitter.with_rpc_recovery(recovery);
        }

        let mut tasks = vec![];
        tasks.push(tokio::spawn(
            async move {
                with_rpc_operation(
                    RpcOperation::ValidatorCheckpoint,
                    backfill_submitter
                        .backfill_checkpoint_submitter(backfill_target, backfill_tree),
                )
                .await
            }
            .instrument(info_span!("BackfillCheckpointSubmitter")),
        ));

        tasks.push(tokio::spawn(
            async move {
                with_rpc_operation(
                    RpcOperation::ValidatorCheckpoint,
                    submitter.checkpoint_submitter(tip_tree.tree),
                )
                .await
            }
            .instrument(info_span!("TipCheckpointSubmitter")),
        ));

        tasks
    }

    fn log_on_announce_failure(result: ChainResult<TxOutcome>, chain_signer: &String) {
        match result {
            Ok(outcome) => {
                if outcome.executed {
                    info!(
                        tx_outcome=?outcome,
                        ?chain_signer,
                        "Successfully announced validator",
                    );
                } else {
                    error!(
                        txid=?outcome.transaction_id,
                        gas_used=?outcome.gas_used,
                        gas_price=?outcome.gas_price,
                        ?chain_signer,
                        "Transaction attempting to announce validator reverted. Make sure you have enough funds in your account to pay for transaction fees."
                    );
                }
            }
            Err(err) => {
                error!(
                    ?err,
                    ?chain_signer,
                    "Failed to announce validator. Make sure you have enough funds in your account to pay for gas."
                );
            }
        }
    }

    fn announcement_submission_may_be_in_flight(
        result: &ChainResult<ValidatorAnnounceSubmission>,
    ) -> bool {
        matches!(
            result,
            Ok(ValidatorAnnounceSubmission::Confirmed(outcome)) if outcome.executed
        ) || matches!(
            result,
            Ok(ValidatorAnnounceSubmission::BroadcastError { .. })
        )
    }

    async fn metadata(&self) -> Result<()> {
        let serialized_metadata = serde_json::to_string_pretty(&self.agent_metadata)?;
        self.checkpoint_syncer
            .write_metadata(&serialized_metadata)
            .await
    }

    async fn announce(&self) -> Result<()> {
        let address = self.signer.eth_address();
        let announcement_location = self.checkpoint_syncer.announcement_location();

        // Sign and post the validator announcement
        let announcement = Announcement {
            validator: address,
            mailbox_address: self.origin_chain_conf.addresses.mailbox,
            mailbox_domain: self.origin_chain.id(),
            storage_location: self.announcement_location()?, // Use formatted location for the signed announcement
        };
        let signed_announcement = self.signer.sign(announcement.clone()).await?;
        self.checkpoint_syncer
            .write_announcement(&signed_announcement)
            .await?;

        if self.skip_announce {
            warn!(
                "Skipping on-chain validator announcement (skipAnnounce=true) — \
                 test-only, checkpoints signed by this validator will not be \
                 discoverable by relayers until it actually announces"
            );
            return Ok(());
        }

        // Ensure that the validator has announced themselves before we enter
        // the main validator submit loop. This is to avoid a situation in
        // which the validator is signing checkpoints but has not announced
        // their locations, which makes them functionally unusable.
        let validator_announce = self
            .origin_chain_conf
            .build_validator_announce_reader(&self.core.metrics)
            .await?;
        // Only a real submission needs a signer, gas oracle, or escalator.
        let mut submission_contract: Option<Box<dyn ValidatorAnnounce>> = None;
        let validators: [H256; 1] = [address.into()];
        let mut retry_backoff = AnnouncementRetryBackoff::default();
        loop {
            info!("Checking for validator announcement");
            if let Some(locations) = validator_announce
                .get_announced_storage_locations(&validators)
                .await?
                .first()
            {
                if locations.contains(&announcement_location) {
                    info!(
                        ?locations,
                        ?announcement_location,
                        "Validator has announced signature storage location"
                    );

                    self.core_metrics.set_announced(self.origin_chain.clone());

                    break;
                }
                info!(
                    announced_locations=?locations,
                    "Validator has not announced signature storage location"
                );

                if let Some(chain_signer) = self.core.settings.chains[&self.origin_chain]
                    .chain_signer()
                    .await?
                {
                    let chain_signer_string = chain_signer.address_string();
                    let chain_signer_h256 = chain_signer.address_h256();
                    let now = Instant::now();
                    if !retry_backoff.should_check_funding(now) {
                        sleep(self.interval).await;
                        continue;
                    }
                    retry_backoff.record_funding_check(now);

                    let balance_delta = validator_announce
                        .announce_tokens_needed(signed_announcement.clone(), chain_signer_h256)
                        .await;
                    if retry_backoff.observe_tokens_needed(balance_delta) {
                        info!(
                            eth_validator_address=?announcement.validator,
                            ?chain_signer_string,
                            ?chain_signer_h256,
                            "Validator chain signer is funded; resetting announcement retry backoff",
                        );
                    }

                    let effective_balance_delta =
                        retry_backoff.effective_tokens_needed(balance_delta);
                    if retry_backoff.ready(Instant::now()) {
                        if let Some(balance_delta) =
                            effective_balance_delta.filter(|balance_delta| !balance_delta.is_zero())
                        {
                            let delay = Self::jittered_announcement_retry_delay(
                                retry_backoff.next_failure_delay(),
                            );
                            warn!(
                                tokens_needed=%balance_delta,
                                eth_validator_address=?announcement.validator,
                                ?chain_signer_string,
                                ?chain_signer_h256,
                                retry_delay_ms=delay.as_millis(),
                                consecutive_failures=retry_backoff.consecutive_failures.saturating_add(1),
                                "Please send tokens to your chain signer address to announce",
                            );
                            retry_backoff.record_failure(Instant::now(), delay);
                        } else {
                            info!(eth_validator_address=?announcement.validator, ?chain_signer_string, ?chain_signer_h256, "Attempting self announce");
                            if submission_contract.is_none() {
                                submission_contract = Some(
                                    self.origin_chain_conf
                                        .build_validator_announce(&self.core.metrics)
                                        .await?,
                                );
                            }
                            let result = submission_contract
                                .as_ref()
                                .expect("announcement submission client initialized")
                                .announce_with_status(signed_announcement.clone())
                                .await;
                            let submission_may_be_in_flight =
                                Self::announcement_submission_may_be_in_flight(&result);
                            match result {
                                Ok(ValidatorAnnounceSubmission::Confirmed(outcome)) => {
                                    Self::log_on_announce_failure(
                                        Ok(outcome),
                                        &chain_signer_string,
                                    );
                                }
                                Ok(ValidatorAnnounceSubmission::BroadcastError {
                                    tx_id,
                                    error,
                                }) => {
                                    error!(
                                        ?tx_id,
                                        ?error,
                                        chain_signer=?chain_signer_string,
                                        "Failed to track broadcast validator announcement; gas escalator retains ownership",
                                    );
                                }
                                Err(error) => {
                                    Self::log_on_announce_failure(Err(error), &chain_signer_string);
                                }
                            }
                            if submission_may_be_in_flight {
                                // Any error after receiving a transaction hash leaves the gas
                                // escalator responsible for replacement with the same nonce.
                                retry_backoff.mark_submission_in_flight();
                            } else {
                                let delay = Self::jittered_announcement_retry_delay(
                                    retry_backoff.next_failure_delay(),
                                );
                                info!(
                                    retry_delay_ms = delay.as_millis(),
                                    consecutive_failures =
                                        retry_backoff.consecutive_failures.saturating_add(1),
                                    "Scheduled validator announcement retry",
                                );
                                retry_backoff.record_failure(Instant::now(), delay);
                            }
                        }
                    }
                } else {
                    warn!(origin_chain=%self.origin_chain, "Cannot announce validator without a signer; make sure a signer is set for the origin chain");
                }

                sleep(self.interval).await;
            }
        }
        Ok(())
    }

    fn jittered_announcement_retry_delay(delay: Duration) -> Duration {
        let jitter_permille = rand::thread_rng().gen_range(
            ANNOUNCEMENT_RETRY_MIN_JITTER_PERMILLE..=ANNOUNCEMENT_RETRY_MAX_JITTER_PERMILLE,
        );
        AnnouncementRetryBackoff::jittered(delay, jitter_permille)
    }

    async fn report_latest_checkpoints_from_each_endpoint(
        reorg_reporter: &dyn ReorgReporter,
        checkpoint_syncer_result: &Result<Box<dyn CheckpointSyncer>, CheckpointSyncerBuildError>,
    ) {
        if let Err(CheckpointSyncerBuildError::ReorgFlag(reorg_resp)) =
            checkpoint_syncer_result.as_ref()
        {
            match reorg_resp.event.as_ref() {
                Some(reorg_event) => {
                    reorg_reporter
                        .report_with_reorg_period(&reorg_event.reorg_period)
                        .await;
                }
                None => {
                    tracing::error!(
                        "Failed to parse reorg event, reporting with default reorg period"
                    );
                    reorg_reporter
                        .report_with_reorg_period(&ReorgPeriod::None)
                        .await;
                }
            }
        }
    }

    fn announcement_location(&self) -> Result<String> {
        let location = self.checkpoint_syncer.announcement_location();
        if self.origin_chain.domain_protocol() == hyperlane_core::HyperlaneDomainProtocol::Aleo {
            Self::aleo_announcement_location(location)
        } else {
            Ok(location)
        }
    }

    fn aleo_announcement_location(announcement_location: String) -> Result<String> {
        // Aleo announcement locations are fixed size C strings of 480 bytes (include nulls)
        let mut bytes = announcement_location.into_bytes();
        // Ensure it fits within 479 bytes (leaving room for null terminator)
        if bytes.len() > 479 {
            return Err(eyre!(
                "Aleo announcement location too long: {} bytes (max 479)",
                bytes.len()
            ));
        }
        // Pad remaining bytes with nulls up to 480 total
        bytes.resize(480, 0);
        String::from_utf8(bytes).map_err(|e| {
            eyre!(
                "Failed to convert Aleo announcement location to string: {}",
                e
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::rpc::chain_conf_for_read_url;
    use hyperlane_base::settings::ChainConnectionConf;
    use hyperlane_ethereum::RpcConnectionConf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use hyperlane_core::{test_utils::dummy_domain, ChainCommunicationError};
    use prometheus::Registry;

    use super::*;
    use crate::test_utils::mock_merkle_tree_hook::MockMerkleTreeHook;

    #[tokio::test(start_paused = true)]
    async fn announcement_retry_backoff_grows_and_caps() {
        let mut backoff = AnnouncementRetryBackoff::default();
        let expected_delays = [
            Duration::from_secs(30),
            Duration::from_secs(60),
            Duration::from_secs(120),
            Duration::from_secs(240),
            Duration::from_secs(480),
            Duration::from_secs(900),
            Duration::from_secs(900),
        ];

        for expected_delay in expected_delays {
            let now = Instant::now();
            assert!(backoff.ready(now));
            assert_eq!(backoff.next_failure_delay(), expected_delay);
            backoff.record_failure(now, expected_delay);
            assert!(!backoff.ready(now));

            let before_deadline = expected_delay
                .checked_sub(Duration::from_millis(1))
                .expect("retry delays exceed one millisecond");
            tokio::time::advance(before_deadline).await;
            assert!(!backoff.ready(Instant::now()));
            tokio::time::advance(Duration::from_millis(1)).await;
            assert!(backoff.ready(Instant::now()));
        }
    }

    #[test]
    fn announcement_retry_jitter_stays_bounded() {
        assert_eq!(
            AnnouncementRetryBackoff::jittered(Duration::from_secs(30), 0),
            Duration::from_secs(24)
        );
        assert_eq!(
            AnnouncementRetryBackoff::jittered(Duration::from_secs(30), 900),
            Duration::from_secs(27)
        );
        assert_eq!(
            AnnouncementRetryBackoff::jittered(Duration::from_secs(30), u32::MAX),
            Duration::from_secs(30)
        );
        assert_eq!(
            AnnouncementRetryBackoff::jittered(
                ANNOUNCEMENT_RETRY_MAX_DELAY,
                ANNOUNCEMENT_RETRY_MAX_JITTER_PERMILLE,
            ),
            ANNOUNCEMENT_RETRY_MAX_DELAY
        );
    }

    #[tokio::test(start_paused = true)]
    async fn sustained_unfunded_then_confirmed_funding_resets_retry_immediately() {
        let mut backoff = AnnouncementRetryBackoff::default();
        let now = Instant::now();
        backoff.record_failure(now, ANNOUNCEMENT_RETRY_MAX_DELAY);
        assert!(!backoff.observe_tokens_needed(None));
        assert!(!backoff.ready(now));

        assert!(!backoff.observe_tokens_needed(Some(U256::from(10_u64))));
        assert!(!backoff.observe_tokens_needed(Some(U256::from(10_u64))));
        assert!(backoff.observe_tokens_needed(Some(U256::zero())));
        assert!(backoff.ready(now));
        assert_eq!(backoff.consecutive_failures, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn funding_preflight_uses_bounded_polling_while_submission_backs_off() {
        let mut backoff = AnnouncementRetryBackoff::default();
        let now = Instant::now();
        assert!(!backoff.observe_tokens_needed(Some(U256::from(1_u64))));
        backoff.record_failure(now, ANNOUNCEMENT_RETRY_MAX_DELAY);
        assert!(backoff.should_check_funding(now));
        backoff.record_funding_check(now);
        assert!(!backoff.should_check_funding(now));

        let before_poll = ANNOUNCEMENT_FUNDING_POLL_INTERVAL
            .checked_sub(Duration::from_millis(1))
            .expect("funding poll interval exceeds one millisecond");
        tokio::time::advance(before_poll).await;
        assert!(!backoff.should_check_funding(Instant::now()));
        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(backoff.should_check_funding(Instant::now()));
    }

    #[tokio::test(start_paused = true)]
    async fn unavailable_funding_preflight_waits_for_submission_retry_deadline() {
        let mut backoff = AnnouncementRetryBackoff::default();
        let now = Instant::now();
        backoff.record_funding_check(now);
        backoff.record_failure(now, ANNOUNCEMENT_RETRY_MAX_DELAY);

        assert_eq!(backoff.last_tokens_needed, None);
        assert!(!backoff.should_check_funding(now));
        tokio::time::advance(ANNOUNCEMENT_RETRY_MAX_DELAY).await;
        assert!(backoff.should_check_funding(Instant::now()));
    }

    #[tokio::test(start_paused = true)]
    async fn funded_preflight_waits_for_submission_retry_deadline() {
        let mut backoff = AnnouncementRetryBackoff::default();
        let now = Instant::now();
        assert!(!backoff.observe_tokens_needed(Some(U256::zero())));
        backoff.record_funding_check(now);
        backoff.record_failure(now, ANNOUNCEMENT_RETRY_MAX_DELAY);

        assert!(!backoff.should_check_funding(now));
        tokio::time::advance(ANNOUNCEMENT_RETRY_MAX_DELAY).await;
        assert!(backoff.should_check_funding(Instant::now()));
    }

    #[tokio::test(start_paused = true)]
    async fn in_flight_announcement_never_creates_a_second_submission_stream() {
        let mut backoff = AnnouncementRetryBackoff::default();
        let now = Instant::now();
        backoff.record_failure(now, Duration::from_secs(30));
        backoff.record_failure(now, Duration::from_secs(60));

        backoff.mark_submission_in_flight();
        assert_eq!(backoff.consecutive_failures, 0);
        assert!(!backoff.ready(now));
        assert!(!backoff.should_check_funding(now));
        tokio::time::advance(ANNOUNCEMENT_RETRY_MAX_DELAY.saturating_mul(10)).await;
        assert!(!backoff.ready(Instant::now()));
        assert!(!backoff.should_check_funding(Instant::now()));

        // Delayed zero preflight or a transient unfunded/funded flap cannot erase in-flight state.
        assert!(!backoff.observe_tokens_needed(Some(U256::from(1_u64))));
        assert!(!backoff.observe_tokens_needed(Some(U256::zero())));
        assert!(!backoff.ready(Instant::now()));
    }

    #[test]
    fn every_post_broadcast_error_suppresses_outer_resubmission() {
        let tx_id = hyperlane_core::H512::from_low_u64_be(9);
        let dropped_tx_id = H256::from_low_u64_be(9);
        let post_broadcast_errors = [
            ChainCommunicationError::TransactionDropped(dropped_tx_id),
            ChainCommunicationError::TransactionTimeout,
            ChainCommunicationError::from_other_str("receipt provider failed"),
        ];

        for error in post_broadcast_errors {
            let result = Ok(ValidatorAnnounceSubmission::BroadcastError { tx_id, error });
            assert!(Validator::announcement_submission_may_be_in_flight(&result));
        }
    }

    #[test]
    fn pre_broadcast_error_remains_retryable() {
        let result = Err(ChainCommunicationError::from_other_str(
            "initial send failed",
        ));
        assert!(!Validator::announcement_submission_may_be_in_flight(
            &result
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn transient_preflight_failure_preserves_known_unfunded_gate_and_backoff() {
        let mut backoff = AnnouncementRetryBackoff::default();
        let now = Instant::now();
        let unfunded = U256::from(25_u64);
        assert!(!backoff.observe_tokens_needed(Some(unfunded)));
        backoff.record_failure(now, ANNOUNCEMENT_RETRY_MIN_DELAY);

        assert!(!backoff.observe_tokens_needed(None));
        assert_eq!(backoff.effective_tokens_needed(None), Some(unfunded));
        tokio::time::advance(ANNOUNCEMENT_RETRY_MIN_DELAY).await;
        assert!(backoff.ready(Instant::now()));
        assert_eq!(backoff.effective_tokens_needed(None), Some(unfunded));
    }

    #[test]
    fn single_unfunded_funded_flap_does_not_reset_failed_submission_backoff() {
        let mut backoff = AnnouncementRetryBackoff::default();
        let now = Instant::now();
        backoff.record_failure(now, ANNOUNCEMENT_RETRY_MAX_DELAY);

        assert!(!backoff.observe_tokens_needed(Some(U256::from(1_u64))));
        assert!(!backoff.observe_tokens_needed(Some(U256::zero())));
        assert!(!backoff.ready(now));
    }

    fn dummy_ethereum_chain_conf(rpc_urls: Vec<Url>) -> ChainConf {
        ChainConf {
            domain: dummy_domain(1337, "test-domain"),
            signer: None,
            identity: None,
            submitter: Default::default(),
            estimated_block_time: Duration::from_secs_f64(1.0),
            reorg_period: Default::default(),
            addresses: Default::default(),
            connection: ChainConnectionConf::Ethereum(hyperlane_ethereum::ConnectionConf {
                rpc_connection: RpcConnectionConf::HttpFallback { urls: rpc_urls },
                transaction_overrides: Default::default(),
                op_submission_config: Default::default(),
                consider_null_transaction_receipt: false,
                fallback_hedge: None,
            }),
            metrics_conf: Default::default(),
            index: Default::default(),
            confirmations: Default::default(),
            chain_id: Default::default(),
            ignore_reorg_reports: false,
            native_token: Default::default(),
        }
    }

    #[test]
    fn lightweight_rpc_deduplication_preserves_order() {
        let a = Url::parse("https://rpc.example/a").expect("URL");
        let b = Url::parse("https://rpc.example/b").expect("URL");
        assert_eq!(
            dedupe_rpc_urls(vec![a.clone(), a.clone(), b.clone()], "rpcUrls"),
            vec![a, b]
        );
    }

    #[test]
    fn chain_conf_for_read_url_uses_single_http_connection() {
        let chain_conf = dummy_ethereum_chain_conf(vec![
            Url::parse("http://rpc-a.example").unwrap(),
            Url::parse("http://rpc-b.example").unwrap(),
        ]);
        let url = Url::parse("http://quorum-node.example").unwrap();

        let per_url_conf = chain_conf_for_read_url(&chain_conf, url.clone(), RpcRole::Primary);

        match per_url_conf.connection {
            ChainConnectionConf::Ethereum(conn) => match conn.rpc_connection {
                RpcConnectionConf::Http { url: got } => assert_eq!(got, url),
                other => panic!("expected a single Http connection, got {other:?}"),
            },
            _ => panic!("expected an ethereum connection"),
        }
        assert_eq!(per_url_conf.metrics_conf.rpc_role, RpcRole::Primary);
    }

    #[test]
    fn chain_conf_for_read_url_preserves_websocket_connection() {
        let chain_conf =
            dummy_ethereum_chain_conf(vec![Url::parse("http://rpc-a.example").unwrap()]);
        let url = Url::parse("wss://quorum-node.example").unwrap();

        let per_url_conf = chain_conf_for_read_url(&chain_conf, url.clone(), RpcRole::Primary);

        match per_url_conf.connection {
            ChainConnectionConf::Ethereum(conn) => match conn.rpc_connection {
                RpcConnectionConf::Ws { url: got } => assert_eq!(got, url),
                other => panic!("expected a Ws connection, got {other:?}"),
            },
            _ => panic!("expected an ethereum connection"),
        }
        assert_eq!(per_url_conf.metrics_conf.rpc_role, RpcRole::Primary);
    }

    #[test]
    fn lightweight_isolates_the_state_read_transport_for_every_protocol() {
        use hyperlane_base::settings::{parser::RawAgentConf, Settings};
        use hyperlane_core::config::{ConfigPath, FromRawConf};

        for (protocol, source) in [
            ("ethereum", "rpcUrls"),
            ("sealevel", "rpcUrls"),
            ("cosmos", "grpcUrls"),
            ("cosmosnative", "grpcUrls"),
            ("starknet", "rpcUrls"),
            ("radix", "rpcUrls"),
            ("tron", "walletSolidityUrls"),
            #[cfg(feature = "aleo")]
            ("aleo", "rpcUrls"),
        ] {
            let raw = serde_json::json!({
                "lightweight": true, "originchainname": "test",
                "websocketurl": "wss://scraper.example/events",
                "validator": {"type": "hexKey", "key": format!("0x{}", "11".repeat(32))},
                "checkpointsyncer": {"type": "localStorage", "path": "/tmp/lightweight-checkpoints"},
                "chains": {"test": {
                    "name": "test", "domainid": 1337,
                    "chainid": if protocol.starts_with("cosmos") { "test-1" } else { "1337" },
                    "protocol": protocol,
                    "rpcurls": [{"http": "https://rpc-a.example"}, {"http": "https://rpc-b.example"}],
                    "rpcconsensustype": "single",
                    "grpcurls": [{"http": "https://grpc-a.example"}, {"http": "https://grpc-b.example"}],
                    "walleturls": [{"http": "https://wallet.example"}],
                    "walletsolidityurls": [{"http": "https://solid-a.example"}, {"http": "https://solid-b.example"}],
                    "gatewayurls": [{"http": "https://gateway.example"}],
                    "bech32prefix": "test", "gasprice": {"denom": "utest", "amount": "0.1"},
                    "contractaddressbytes": 32, "networkname": "mainnet",
                    "nativetoken": {"denom": "0x0000000000000000000000000000000000000005", "decimals": 18, "symbol": "TEST"},
                    "mailboxprogram": "mailbox.aleo", "hookmanagerprogram": "hooks.aleo",
                    "ismmanagerprogram": "isms.aleo", "validatorannounceprogram": "announce.aleo",
                    "mailbox": "0x0000000000000000000000000000000000000001",
                    "interchaingaspaymaster": "0x0000000000000000000000000000000000000002",
                    "validatorannounce": "0x0000000000000000000000000000000000000003",
                    "merkletreehook": "0x0000000000000000000000000000000000000004"
                }}
            });
            let settings = Settings::from_config(
                serde_json::from_value::<RawAgentConf>(raw).unwrap(),
                &ConfigPath::default(),
                "validator",
            )
            .unwrap_or_else(|err| panic!("{protocol}: {err}"));
            let chain = &settings.chains[&settings.lookup_domain("test").unwrap()];
            let raw_rpc_urls = vec![
                Url::parse("https://rpc-a.example").unwrap(),
                Url::parse("https://rpc-b.example").unwrap(),
            ];
            let (selected_source, urls) = state_read_urls(chain, raw_rpc_urls).unwrap();
            assert_eq!(selected_source, source, "{protocol}");
            assert_eq!(urls.len(), 2, "{protocol}");
            for url in urls {
                let per_url = chain_conf_for_read_url(chain, url.clone(), RpcRole::Primary);
                let actual = match per_url.connection {
                    ChainConnectionConf::Ethereum(conn) => conn.rpc_urls(),
                    ChainConnectionConf::Sealevel(conn) => conn.urls,
                    ChainConnectionConf::Starknet(conn) => conn.urls,
                    ChainConnectionConf::Cosmos(conn) | ChainConnectionConf::CosmosNative(conn) => {
                        conn.grpc_urls
                    }
                    ChainConnectionConf::Tron(conn) => conn.wallet_solidity_urls,
                    ChainConnectionConf::Radix(conn) => conn.core,
                    #[cfg(feature = "aleo")]
                    ChainConnectionConf::Aleo(conn) => conn.rpcs,
                    ChainConnectionConf::Fuel(_) => panic!("unsupported protocol"),
                };
                assert_eq!(
                    actual,
                    vec![url],
                    "{protocol} must not retain a shared root-read pool"
                );
            }
        }
    }

    #[tokio::test]
    async fn build_validator_per_url_hooks_produces_one_hook_per_url() {
        let chain_conf =
            dummy_ethereum_chain_conf(vec![Url::parse("http://normal-rpc.example").unwrap()]);
        let urls = vec![
            Url::parse("http://quorum-a.example").unwrap(),
            Url::parse("http://quorum-b.example").unwrap(),
            Url::parse("http://quorum-c.example").unwrap(),
        ];
        let metrics = Arc::new(
            CoreMetrics::new(
                "validator-test-ethereum-quorum-hooks",
                9091,
                Registry::new(),
            )
            .unwrap(),
        );

        let hooks = build_validator_per_url_hooks(
            &chain_conf,
            "rpcUrls",
            RpcRole::Primary,
            &urls,
            &metrics,
        )
        .await
        .unwrap();

        assert_eq!(hooks.len(), 3);
        let labels: Vec<&str> = hooks.iter().map(|(label, _)| label.as_str()).collect();
        assert_eq!(labels, vec!["rpcUrls[0]", "rpcUrls[1]", "rpcUrls[2]"]);
    }

    #[tokio::test]
    async fn unavailable_or_stalled_ws_does_not_veto_pool_initialization() {
        use futures_util::StreamExt;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::AsyncWriteExt;
        for stalled in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let attempts = Arc::new(AtomicUsize::new(0));
            let observed = attempts.clone();
            let server = tokio::spawn(async move {
                let mut sockets = Vec::new();
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    observed.fetch_add(1, Ordering::SeqCst);
                    if stalled {
                        sockets.push(socket);
                    } else {
                        socket
                            .write_all(
                                b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
                            )
                            .await
                            .unwrap();
                    }
                }
            });
            let chain = dummy_ethereum_chain_conf(vec![]);
            let urls = vec![
                Url::parse("https://a.example").unwrap(),
                Url::parse("https://b.example").unwrap(),
                Url::parse(&format!("ws://{address}")).unwrap(),
            ];
            let metrics = Arc::new(CoreMetrics::new("ws-test", 0, Registry::new()).unwrap());
            let hooks = tokio::time::timeout(
                Duration::from_secs(1),
                build_validator_per_url_hooks(&chain, "rpcUrls", RpcRole::Primary, &urls, &metrics),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(hooks.len(), 3);
            assert_eq!(
                attempts.load(Ordering::SeqCst),
                0,
                "construction does not connect"
            );
            let ws = hooks[2].1.clone();
            for _ in 0..2 {
                let result = tokio::time::timeout(
                    Duration::from_millis(100),
                    ws.latest_checkpoint(&ReorgPeriod::None),
                )
                .await;
                if stalled {
                    assert!(result.is_err());
                } else {
                    assert!(result.unwrap().is_err());
                }
            }
            assert_eq!(
                attempts.load(Ordering::SeqCst),
                2,
                "failed or cancelled initialization retries"
            );
            let mut voters: Vec<Arc<dyn MerkleTreeHook>> = Vec::new();
            for _ in 0..2 {
                let mut hook = MockMerkleTreeHook::new();
                hook.expect_latest_checkpoint().once().returning(|_| {
                    Ok(CheckpointAtBlock {
                        checkpoint: hyperlane_core::Checkpoint {
                            merkle_tree_hook_address: H256::zero(),
                            mailbox_domain: 1337,
                            root: H256::zero(),
                            index: 0,
                        },
                        block_height: None,
                    })
                });
                voters.push(Arc::new(hook));
            }
            voters.push(ws);
            let reader = CheckpointReader::new(
                crate::checkpoint_consensus::CheckpointConsensus::Majority,
                voters,
            )
            .unwrap();
            assert_eq!(reader.endpoint_count(), 3);
            assert_eq!(reader.consensus.required(reader.endpoint_count()), 2);
            let period = ReorgPeriod::None;
            let mut stream = reader.checkpoint_stream(&period);
            for _ in 0..2 {
                let (slot, checkpoint) =
                    tokio::time::timeout(Duration::from_secs(1), stream.next())
                        .await
                        .unwrap()
                        .unwrap();
                assert!(slot < 2);
                assert!(checkpoint.is_some());
            }
            server.abort();
            assert!(server.await.unwrap_err().is_cancelled());
        }
    }

    #[tokio::test]
    async fn malformed_rpc_endpoint_is_fatal_before_initialization() {
        let chain = dummy_ethereum_chain_conf(vec![]);
        let metrics = Arc::new(CoreMetrics::new("invalid-rpc-test", 0, Registry::new()).unwrap());
        let urls = vec![Url::parse("file:///invalid").unwrap()];
        assert!(build_validator_per_url_hooks(
            &chain,
            "rpcUrls",
            RpcRole::Primary,
            &urls,
            &metrics
        )
        .await
        .is_err());
    }

    #[tokio::test(start_paused = true)]
    #[tracing_test::traced_test]
    async fn empty_tree_waits_then_starts_from_first_message_without_restart() {
        let count_calls = Arc::new(AtomicUsize::new(0));
        let mut hook = MockMerkleTreeHook::new();
        hook.expect_count().times(2).returning({
            let count_calls = Arc::clone(&count_calls);
            move |_| {
                Ok(if count_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    0
                } else {
                    1
                })
            }
        });
        hook.expect_tree().once().return_once(|_| {
            let mut tree = hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
            tree.ingest(H256::from_low_u64_be(1));
            Ok(IncrementalMerkleAtBlock {
                tree,
                block_height: Some(10),
            })
        });

        let readiness = Arc::new(ValidatorReadiness::default());
        let readiness_hook: Arc<dyn MerkleTreeHook> = Arc::new(ReadinessMerkleTreeHook::new(
            Arc::new(hook),
            Arc::clone(&readiness),
            "merkle_tree_hook",
        ));
        let task = tokio::spawn({
            let readiness = Arc::clone(&readiness);
            async move {
                wait_for_first_message(
                    readiness_hook,
                    &ReorgPeriod::None,
                    Duration::from_secs(5),
                    &readiness,
                )
                .await
            }
        });

        tokio::task::yield_now().await;
        assert_eq!(
            readiness.snapshot().state,
            validator_server::ValidatorReadinessState::WaitingForFirstMessage
        );
        assert!(!logs_contain("Error getting merkle tree"));

        tokio::time::advance(Duration::from_secs(5)).await;
        let tree = task.await.expect("wait task should complete");
        assert_eq!(tree.count(), 1);
        assert_eq!(
            readiness.snapshot().state,
            validator_server::ValidatorReadinessState::Ready
        );
    }

    #[test]
    fn aleo_announcement_location_exactly_max_minus_null() -> Result<()> {
        // 479 bytes input should be padded to 480 with a single null
        let input = "a".repeat(479);
        let out = Validator::aleo_announcement_location(input.clone())?;
        let bytes = out.into_bytes();
        assert_eq!(bytes.len(), 480);
        assert_eq!(bytes[..479], input.as_bytes()[..]);
        assert_eq!(bytes[479], 0);
        Ok(())
    }

    #[test]
    fn aleo_announcement_location_short_input_padded_to_480() -> Result<()> {
        let input = "hello";
        let out = Validator::aleo_announcement_location(input.to_string())?;
        let bytes = out.into_bytes();
        assert_eq!(bytes.len(), 480);
        assert_eq!(&bytes[..5], input.as_bytes());
        assert!(bytes[5..].iter().all(|&b| b == 0));
        Ok(())
    }

    #[test]
    fn aleo_announcement_location_empty_string_padded_to_480() -> Result<()> {
        let input = "";
        let out = Validator::aleo_announcement_location(input.to_string())?;
        let bytes = out.into_bytes();
        assert_eq!(bytes.len(), 480);
        assert!(bytes.iter().all(|&b| b == 0));
        Ok(())
    }

    #[test]
    fn aleo_announcement_location_rejects_too_long() {
        // 480 bytes input would exceed allowed (must be <= 479)
        let input = "b".repeat(480);
        let err = Validator::aleo_announcement_location(input).unwrap_err();
        let msg = format!("{}", err);
        assert!(msg.contains("Aleo announcement location too long"));
        assert!(msg.contains("max 479"));
    }

    #[test]
    fn aleo_announcement_location_preserves_existing_nulls_and_utf8() -> Result<()> {
        // Input containing interior null bytes and multi-byte UTF-8
        let mut input_bytes = Vec::new();
        input_bytes.extend_from_slice("αβγ".as_bytes()); // UTF-8 multi-byte
        input_bytes.push(0); // interior null
        input_bytes.extend_from_slice("xyz".as_bytes());
        let input = String::from_utf8(input_bytes.clone()).unwrap();
        let out = Validator::aleo_announcement_location(input.clone())?;
        let out_bytes = out.into_bytes();

        // Leading content preserved
        assert_eq!(&out_bytes[..input_bytes.len()], &input_bytes[..]);
        // Padded with zeros to 480
        assert_eq!(out_bytes.len(), 480);
        assert!(out_bytes[input_bytes.len()..].iter().all(|&b| b == 0));
        Ok(())
    }
}
