use std::{
    collections::{HashMap, HashSet},
    fmt::Debug,
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use axum::Router;
use derive_more::AsRef;
use ethers::utils::keccak256;
use eyre::{eyre, Result};
use futures_util::future::{join_all, try_join_all};
use serde::Serialize;
use tokio::{
    task::JoinHandle,
    time::{sleep, timeout},
};
use tracing::{debug, error, info, info_span, warn, Instrument};
use url::Url;

use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB, DB},
    git_sha,
    metrics::AgentMetrics,
    settings::{ChainConf, ChainConnectionConf, CheckpointSyncerBuildError},
    BaseAgent, ChainMetrics, ChainSpecificMetricsUpdater, CheckpointSyncer, ContractSyncMetrics,
    ContractSyncer, CoreMetrics, HyperlaneAgentCore, MetadataFromSettings, RuntimeMetrics,
    SequencedDataContractSync,
};
use hyperlane_core::{
    rpc_clients::{call_and_retry_indefinitely, RPC_RETRY_SLEEP_DURATION},
    Announcement, ChainCommunicationError, ChainResult, Checkpoint, CheckpointAtBlock,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneSigner, HyperlaneSignerExt,
    IncrementalMerkleAtBlock, Mailbox, MerkleTreeHook, MerkleTreeInsertion, ReorgPeriod, TxOutcome,
    ValidatorAnnounce, H256, U256,
};
use hyperlane_ethereum::{RpcConnectionConf, Signers, SingletonSigner, SingletonSignerHandle};
use hyperlane_metric::prometheus_metric::RpcRole;

use crate::reorg_reporter::{
    LatestCheckpointReorgReporter, LatestCheckpointReorgReporterWithStorageWriter, ReorgReporter,
};
use crate::server::{self as validator_server, merkle_tree_insertions};
use crate::{
    settings::ValidatorSettings,
    submit::{ValidatorSubmitter, ValidatorSubmitterMetrics},
};

const CURSOR_INSTANTIATION_ATTEMPTS: usize = 10;

/// Caps how long any single quorum/base-hook RPC call can take, so one hanging endpoint
/// can't stall a safety-critical read (and therefore checkpoint signing) indefinitely.
const QUORUM_RPC_CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// Below this, the combined `rpcUrls` + `additionalQuorumRpcUrls` pool gives little to no
/// real protection: with 1 entry any value trivially reaches quorum, and with 2 entries
/// all must unanimously agree.
const MIN_RECOMMENDED_QUORUM_RPCS: usize = 3;

/// `count()`/domain/address come from `base_hook` (the normal `rpcUrls` connection, using
/// whatever consensus mode it's configured with). `tree()`/`tree_at_block()` — the actual
/// merkle tree root reads — require BOTH: a 2/3 majority across `quorum_hooks` (one entry
/// per `rpcUrls` URL plus one per `additionalQuorumRpcUrls` URL, independent of each
/// other), AND that majority-agreed value to match what `base_hook` independently
/// returns. An attacker needs to compromise both the merged vote and `rpcUrls`' own
/// consensus at once to force a wrong value through.
///
/// `latest_checkpoint()`/`latest_checkpoint_at_block()` never independently call
/// `quorum_hooks`: they derive the `Checkpoint` locally (root/index from the tree,
/// address/domain already known) from a `tree()`/`tree_at_block()` read, so the
/// public-RPC-inclusive `quorum_hooks` pool is only ever exercised for root reads.
#[derive(Debug)]
struct ValidatorMultiRpcQuorumMerkleTreeHook {
    base_hook: Arc<dyn MerkleTreeHook>,
    /// Paired with an `rpcUrls[i]`/`additionalQuorumRpcUrls[i]` index label (0-based), not
    /// the host/URL itself — some entries may be private RPCs, so logging which one
    /// disagreed must never reveal which URL/provider that is.
    quorum_hooks: Vec<(String, Arc<dyn MerkleTreeHook>)>,
}

impl ValidatorMultiRpcQuorumMerkleTreeHook {
    /// Bounds a single `quorum_hooks` RPC call to `QUORUM_RPC_CALL_TIMEOUT`, so one hanging
    /// endpoint can't stall a whole read (`join_all` otherwise waits for every response
    /// before voting, including stragglers past the point a result is already decided).
    ///
    /// Deliberately NOT used for `base_hook` calls: each `quorum_hooks` entry is a single,
    /// unwrapped HTTP connection (`ethereum_chain_conf_for_url`), so this is the only bound
    /// on how long it can take. `base_hook` instead uses whatever consensus mode `rpcUrls`
    /// is configured with (e.g. `Fallback`, which internally cycles across providers, each
    /// with its own ~60s HTTP client timeout) — wrapping that whole call in a shorter outer
    /// timeout would cancel it before that internal cycling can complete, defeating it
    /// rather than bounding it.
    async fn with_call_timeout<T>(
        fut: impl std::future::Future<Output = ChainResult<T>>,
    ) -> ChainResult<T> {
        match timeout(QUORUM_RPC_CALL_TIMEOUT, fut).await {
            Ok(result) => result,
            Err(_) => Err(ChainCommunicationError::from_other_str(
                "quorum RPC call timed out",
            )),
        }
    }

    /// Resolves `reorg_period` to a concrete block height via `base_hook`, so every
    /// quorum RPC and `base_hook` itself can be pinned to the same height instead of
    /// each independently resolving its own current tip. `Blocks(n)` periods almost never
    /// agree across independent RPCs on an active chain otherwise. Returns `None` for a
    /// tag-based reorg period, which doesn't resolve to an explicit height.
    ///
    /// Known limitation: this call is intentionally NOT wrapped in `with_call_timeout` (see
    /// that fn's doc comment) and inherits whatever consensus mode `base_hook` is configured
    /// with. Under `Fallback` consensus specifically, a first-priority endpoint that responds
    /// successfully but with a stale height (rather than erroring) can't be detected here —
    /// ethers' `FallbackProvider` has no notion of freshness, only success/error — and would
    /// stall height (and therefore checkpoint) progress indefinitely. This is an existing
    /// characteristic of `Fallback` consensus generally, not introduced by quorum
    /// verification; `Quorum` consensus naturally tolerates a single stale outlier via
    /// majority agreement. A real fix needs cross-provider freshness/skew checks, which is a
    /// bigger design effort left for a follow-up.
    async fn resolve_quorum_target_height(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<Option<u64>> {
        Ok(self
            .base_hook
            .latest_checkpoint(reorg_period)
            .await?
            .block_height)
    }

    /// Ceiling of `2 * n / 3`, i.e. the smallest count that's at least two thirds of `n`.
    fn two_thirds_threshold(n: usize) -> usize {
        n.saturating_mul(2).div_ceil(3)
    }

    /// Majority vote (2/3) across `quorum_hooks`' results.
    fn select_quorum_result<T: Clone + Debug>(
        &self,
        results: Vec<(String, ChainResult<T>)>,
        matches: impl Fn(&T, &T) -> bool,
        context: &str,
    ) -> ChainResult<T> {
        let mut oks: Vec<(String, T)> = Vec::new();
        let mut first_err = None;
        // Identified by label prefix (see `build_validator_ethereum_per_url_hooks`), not a
        // separate role field: purely observational, doesn't affect the threshold below. A
        // `Primary` (`rpcUrls`) failure is notable even when the round still succeeds via
        // `additionalQuorumRpcUrls`/still counts fully against the fixed denominator either
        // way - ops should know an `rpcUrls` entry is unhealthy.
        let mut failed_primary_rpcs: Vec<String> = Vec::new();

        for (label, result) in results {
            match result {
                Ok(value) => oks.push((label, value)),
                Err(err) => {
                    if label.starts_with("rpcUrls[") {
                        failed_primary_rpcs.push(label.clone());
                    }
                    if first_err.is_none() {
                        first_err = Some(err);
                    }
                }
            }
        }

        if !failed_primary_rpcs.is_empty() {
            warn!(
                context,
                failed_primary_rpcs = ?failed_primary_rpcs,
                "rpcUrls entries failed this round; they still count against the quorum threshold"
            );
        }

        let threshold = Self::two_thirds_threshold(self.quorum_hooks.len());
        let mut max_agreeing = 0;
        let mut best_agreeing_rpcs: Vec<&str> = Vec::new();

        for (_, candidate) in &oks {
            let agreeing: Vec<&str> = oks
                .iter()
                .filter(|(_, other)| matches(candidate, other))
                .map(|(label, _)| label.as_str())
                .collect();
            if agreeing.len() > max_agreeing {
                max_agreeing = agreeing.len();
                best_agreeing_rpcs = agreeing.clone();
            }

            if agreeing.len() >= threshold {
                if agreeing.len() < oks.len() {
                    let disagreeing_rpcs: Vec<&str> = oks
                        .iter()
                        .filter(|(_, other)| !matches(candidate, other))
                        .map(|(label, _)| label.as_str())
                        .collect();
                    // minority outvoted; full values logged separately at debug (can be large)
                    warn!(
                        context,
                        accepted = ?candidate,
                        agreeing_count = agreeing.len(),
                        total_successful = oks.len(),
                        threshold,
                        disagreeing_rpcs = ?disagreeing_rpcs,
                        "Quorum reached despite provider disagreement"
                    );
                    debug!(context, all_values = ?oks, "Full quorum candidate values by RPC");
                }
                return Ok(candidate.clone());
            }
        }

        if oks.is_empty() {
            return Err(
                first_err.unwrap_or_else(|| ChainCommunicationError::from_other_str(context))
            );
        }

        let responding_rpcs: Vec<&str> = oks.iter().map(|(label, _)| label.as_str()).collect();
        warn!(
            context,
            total_successful = oks.len(),
            max_agreeing,
            threshold,
            responding_rpcs = ?responding_rpcs,
            best_agreeing_rpcs = ?best_agreeing_rpcs,
            "Failed to reach quorum: no value reached a 2/3 majority"
        );
        debug!(context, all_values = ?oks, "Full quorum candidate values by RPC");
        Err(ChainCommunicationError::from_other_str(&format!(
            "{context}; best candidate had {max_agreeing}/{threshold} needed \
             (of {total} quorum RPCs)",
            total = oks.len()
        )))
    }

    /// Requires the merged group's accepted value to also match what `base_hook`
    /// (`rpcUrls`, whatever consensus mode it's configured with) independently returns.
    /// Guards against a colluding or compromised subset of the merged vote — most
    /// plausibly the less-trusted `additionalQuorumRpcUrls` entries — outvoting an
    /// honest `rpcUrls`: an attacker also has to compromise `rpcUrls`' own consensus to
    /// force a wrong value through.
    fn require_base_hook_agreement<T: Debug>(
        quorum_result: &T,
        base_result: &T,
        matches: impl Fn(&T, &T) -> bool,
        context: &str,
    ) -> ChainResult<()> {
        if matches(quorum_result, base_result) {
            return Ok(());
        }
        warn!(
            context,
            quorum_result = ?quorum_result,
            base_result = ?base_result,
            "merged quorum consensus disagrees with rpcUrls consensus"
        );
        Err(ChainCommunicationError::from_other_str(&format!(
            "{context}: merged quorum consensus disagrees with rpcUrls consensus"
        )))
    }

    /// Fans a height-pinned tree read out to `quorum_hooks`, requiring both a 2/3 majority
    /// and `base_hook` agreement. Shared by `tree()` (once it resolves a target height) and
    /// `latest_checkpoint_at_block()`, so there's a single place that ever calls
    /// `quorum_hooks` for a pinned-height root read.
    async fn tree_at_block_via_quorum(&self, height: u64) -> ChainResult<IncrementalMerkleAtBlock> {
        let results = join_all(
            self.quorum_hooks
                .iter()
                .cloned()
                .map(|(label, hook)| async move {
                    (
                        label,
                        Self::with_call_timeout(hook.tree_at_block(height)).await,
                    )
                }),
        )
        .await;
        let quorum_result = self.select_quorum_result(
            results,
            |a, b| a.tree == b.tree,
            "Failed to reach quorum for merkle tree",
        )?;
        let base_result = self.base_hook.tree_at_block(height).await?;
        Self::require_base_hook_agreement(
            &quorum_result,
            &base_result,
            |a, b| a.tree == b.tree,
            "Failed to reach quorum for merkle tree",
        )?;
        Ok(quorum_result)
    }

    /// Derives a `Checkpoint` purely locally from an already quorum-verified tree read —
    /// root/index come from the tree, `merkle_tree_hook_address`/`mailbox_domain` are known
    /// without any RPC call. This is why `latest_checkpoint`/`latest_checkpoint_at_block`
    /// never independently fan out to `quorum_hooks`.
    ///
    /// Errors (rather than panicking via `IncrementalMerkle::index()`) on an empty tree, to
    /// match the on-chain `latestCheckpoint()` contract call this replaces: it computes
    /// `count() - 1` under Solidity's checked arithmetic, which reverts (surfaced as a
    /// `ChainResult::Err`, not a panic) when the tree is empty.
    fn checkpoint_from_tree(
        tree: IncrementalMerkleAtBlock,
        merkle_tree_hook_address: H256,
        mailbox_domain: u32,
    ) -> ChainResult<CheckpointAtBlock> {
        if tree.tree.count() == 0 {
            return Err(ChainCommunicationError::from_other_str(
                "cannot derive latest_checkpoint: merkle tree is empty",
            ));
        }
        let checkpoint = Checkpoint {
            merkle_tree_hook_address,
            mailbox_domain,
            root: tree.tree.root(),
            index: tree.tree.index(),
        };
        Ok(CheckpointAtBlock {
            checkpoint,
            block_height: tree.block_height,
        })
    }
}

#[async_trait]
impl MerkleTreeHook for ValidatorMultiRpcQuorumMerkleTreeHook {
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        if let Some(height) = self.resolve_quorum_target_height(reorg_period).await? {
            return self.tree_at_block_via_quorum(height).await;
        }

        let results = join_all(self.quorum_hooks.iter().cloned().map(|(label, hook)| {
            let reorg_period = reorg_period.clone();
            async move {
                (
                    label,
                    Self::with_call_timeout(hook.tree(&reorg_period)).await,
                )
            }
        }))
        .await;
        let quorum_result = self.select_quorum_result(
            results,
            |a, b| a.tree == b.tree && a.block_height == b.block_height,
            "Failed to reach quorum for merkle tree",
        )?;
        let base_result = self.base_hook.tree(reorg_period).await?;
        Self::require_base_hook_agreement(
            &quorum_result,
            &base_result,
            |a, b| a.tree == b.tree,
            "Failed to reach quorum for merkle tree",
        )?;
        Ok(quorum_result)
    }

    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        self.base_hook.count(reorg_period).await
    }

    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        let tree = self.tree(reorg_period).await?;
        Self::checkpoint_from_tree(tree, self.address(), self.domain().id())
    }

    async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock> {
        let tree = self.tree_at_block_via_quorum(height).await?;
        Self::checkpoint_from_tree(tree, self.address(), self.domain().id())
    }
}

impl HyperlaneChain for ValidatorMultiRpcQuorumMerkleTreeHook {
    fn domain(&self) -> &HyperlaneDomain {
        self.base_hook.domain()
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        self.base_hook.provider()
    }
}

impl HyperlaneContract for ValidatorMultiRpcQuorumMerkleTreeHook {
    fn address(&self) -> H256 {
        self.base_hook.address()
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
    merkle_tree_hook_sync: Arc<SequencedDataContractSync<MerkleTreeInsertion>>,
    mailbox: Arc<dyn Mailbox>,
    merkle_tree_hook: Arc<dyn MerkleTreeHook>,
    base_merkle_tree_hook: Arc<dyn MerkleTreeHook>,
    validator_announce: Arc<dyn ValidatorAnnounce>,
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
    reorg_reporter: Arc<dyn ReorgReporter>,
    skip_announce: bool,
}

/// Metadata for `validator`
#[derive(Debug, Serialize)]
pub struct ValidatorMetadata {
    git_sha: String,
    rpcs: Vec<ValidatorMetadataRpcEntry>,
    /// The `additionalQuorumRpcUrls` set, reported separately from `rpcs`.
    additional_quorum_rpcs: Vec<ValidatorMetadataRpcEntry>,
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
        let additional_quorum_rpcs = settings
            .additional_quorum_rpcs
            .iter()
            .map(ValidatorMetadataRpcEntry::hash_rpc)
            .collect();
        ValidatorMetadata {
            git_sha: git_sha(),
            rpcs,
            additional_quorum_rpcs,
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
        // only `rpcs` is gated; additional_quorum_rpcs is safe to be public by design
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

        let reorg_reporter =
            LatestCheckpointReorgReporter::from_settings(&settings, &metrics).await?;
        let reorg_reporter = Arc::new(reorg_reporter) as Arc<dyn ReorgReporter>;

        let checkpoint_syncer_result = settings.checkpoint_syncer.build_and_validate(None).await;

        Self::report_latest_checkpoints_from_each_endpoint(
            &reorg_reporter,
            &checkpoint_syncer_result,
        )
        .await;

        // Be extra sure to panic when checkpoint syncer fails, which indicates
        // a fatal startup error.
        let checkpoint_syncer: Arc<dyn CheckpointSyncer> = checkpoint_syncer_result
            .expect("Failed to build checkpoint syncer")
            .into();

        // If checkpoint syncer initialization was successful, use a reorg-reporter which
        // writes to the storage location in addition to the logs.
        let reorg_reporter_with_storage_writer =
            LatestCheckpointReorgReporterWithStorageWriter::from_settings_with_storage_writer(
                &settings,
                &metrics,
                checkpoint_syncer.clone(),
            )
            .await?;
        let reorg_reporter = Arc::new(reorg_reporter_with_storage_writer) as Arc<dyn ReorgReporter>;

        let origin_chain_conf = core.settings.chain_setup(&settings.origin_chain)?.clone();
        let additional_quorum_rpc_urls: Vec<Url> = Self::dedupe_additional_quorum_rpc_urls(
            settings
                .additional_quorum_rpcs
                .iter()
                .enumerate()
                .map(|(i, rpc)| {
                    // Identify the entry by index, never by the URL itself: it may embed
                    // an API key, and a parse failure (e.g. a typo) is exactly the case
                    // where the URL is most likely to end up copied verbatim into logs.
                    Url::parse(&rpc.url)
                        .map_err(|err| eyre!("Invalid additionalQuorumRpcUrls[{i}] entry: {err}"))
                })
                .collect::<Result<_>>()?,
        );

        let mailbox = origin_chain_conf.build_mailbox(&metrics).await?;

        let base_merkle_tree_hook: Arc<dyn MerkleTreeHook> = settings
            .build_merkle_tree_hook(&settings.origin_chain, &metrics)
            .await?
            .into();

        let merkle_tree_hook: Arc<dyn MerkleTreeHook> = if Self::validator_uses_split_quorum_hook(
            &origin_chain_conf,
            &additional_quorum_rpc_urls,
        ) {
            // `rpcUrls` votes alongside `additionalQuorumRpcUrls` in the same 2/3 quorum
            // group (see `ValidatorMultiRpcQuorumMerkleTreeHook`), so `additionalQuorumRpcUrls`
            // only needs to add public endpoints on top of it. Read the URLs directly from
            // `origin_chain_conf.connection` rather than `settings.rpcs`, which also
            // comingles `grpcUrls`/`walletUrls`/`walletSolidityUrls` (non-Ethereum chains).
            let primary_rpc_urls: Vec<Url> = Self::primary_rpc_urls(&origin_chain_conf);
            let additional_quorum_rpc_urls: Vec<Url> =
                Self::remove_urls_already_in_primary(&primary_rpc_urls, additional_quorum_rpc_urls);
            let combined_urls: Vec<Url> = primary_rpc_urls
                .iter()
                .chain(additional_quorum_rpc_urls.iter())
                .cloned()
                .collect();
            Self::warn_if_quorum_pool_undersized(&combined_urls);
            Self::warn_if_duplicate_hosts(&combined_urls);
            Self::build_validator_quorum_merkle_tree_hook(
                base_merkle_tree_hook.clone(),
                &origin_chain_conf,
                &primary_rpc_urls,
                &additional_quorum_rpc_urls,
                &metrics,
            )
            .await?
            .into()
        } else {
            if !additional_quorum_rpc_urls.is_empty() {
                warn!(
                    origin_chain = %settings.origin_chain,
                    "additionalQuorumRpcUrls is set but ignored: quorum verification is only supported for Ethereum chains"
                );
            }
            base_merkle_tree_hook.clone()
        };

        let validator_announce = settings
            .build_validator_announce(&settings.origin_chain, &metrics)
            .await?;

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));

        let merkle_tree_hook_sync = settings
            .sequenced_contract_sync::<MerkleTreeInsertion, _>(
                &settings.origin_chain,
                &metrics,
                &contract_sync_metrics,
                msg_db.clone().into(),
                false,
                false,
            )
            .await?;

        Ok(Self {
            origin_chain: settings.origin_chain,
            origin_chain_conf,
            core,
            db: msg_db,
            mailbox: mailbox.into(),
            merkle_tree_hook,
            base_merkle_tree_hook,
            merkle_tree_hook_sync,
            validator_announce: validator_announce.into(),
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

        let task = metrics_updater.spawn();
        tasks.push(task);

        // report agent metadata
        self.metadata()
            .await
            .expect("Failed to report agent metadata");

        // announce the validator after spawning the signer task
        self.announce().await.expect("Failed to announce validator");

        // wait for the first message before submitting checkpoints
        loop {
            match self.merkle_tree_hook.tree(&self.reorg_period).await {
                Err(err) => {
                    error!(?err, "Error getting merkle tree");
                    sleep(self.interval).await;
                }
                Ok(tree) if tree.count() == 0 => {
                    info!("Waiting for first message in merkle tree hook");
                    sleep(self.interval).await;
                }
                Ok(_) => {
                    break;
                }
            }
        }

        let merkle_tree_hook_sync = match self
            .try_n_times_to_run_merkle_tree_hook_sync(CURSOR_INSTANTIATION_ATTEMPTS)
            .await
        {
            Ok(s) => s,
            Err(err) => {
                error!(?err, "Failed to run merkle tree hook sync");
                return;
            }
        };
        tasks.push(merkle_tree_hook_sync);
        for checkpoint_sync_task in self.run_checkpoint_submitters().await {
            tasks.push(checkpoint_sync_task);
        }

        tasks.push(self.runtime_metrics.spawn());

        // Note that this only returns an error if one of the tasks panics
        if let Err(err) = try_join_all(tasks).await {
            error!(?err, "One of the validator tasks returned an error");
        }
    }
}

impl Validator {
    /// Opt-in: only true for Ethereum with a non-empty `additionalQuorumRpcUrls`.
    fn validator_uses_split_quorum_hook(
        origin_chain_conf: &ChainConf,
        additional_quorum_rpc_urls: &[Url],
    ) -> bool {
        !additional_quorum_rpc_urls.is_empty()
            && matches!(
                origin_chain_conf.connection,
                ChainConnectionConf::Ethereum(_)
            )
    }

    /// Removes exact duplicate URLs (order-preserving). A duplicated endpoint would
    /// otherwise count as two independent votes, undermining the quorum's independence
    /// assumption.
    fn dedupe_additional_quorum_rpc_urls(urls: Vec<Url>) -> Vec<Url> {
        let original_count = urls.len();
        let mut seen = HashSet::new();
        let deduped: Vec<Url> = urls
            .into_iter()
            .filter(|url| seen.insert(url.clone()))
            .collect();
        if deduped.len() < original_count {
            warn!(
                original_count,
                deduped_count = deduped.len(),
                "additionalQuorumRpcUrls contained duplicate entries; deduping to preserve vote independence"
            );
        }
        deduped
    }

    /// Removes any `additionalQuorumRpcUrls` entry that's also present in `rpcUrls`
    /// (exact-URL match). Without this, a URL present in both pools would supply two
    /// independent-looking `quorum_hooks` votes (one tagged `Primary`, one `Quorum`) plus
    /// `base_hook`'s agreement - collapsing the quorum's independence assumption onto a
    /// single physical endpoint. Order-preserving; only ever removes from the additional
    /// pool, never the primary one, since `rpcUrls` always votes.
    fn remove_urls_already_in_primary(
        primary_rpc_urls: &[Url],
        additional_quorum_rpc_urls: Vec<Url>,
    ) -> Vec<Url> {
        let original_count = additional_quorum_rpc_urls.len();
        let primary_url_set: HashSet<&Url> = primary_rpc_urls.iter().collect();
        let deduped: Vec<Url> = additional_quorum_rpc_urls
            .into_iter()
            .filter(|url| !primary_url_set.contains(url))
            .collect();
        if deduped.len() < original_count {
            warn!(
                original_count,
                deduped_count = deduped.len(),
                "additionalQuorumRpcUrls contained entries already present in rpcUrls; \
                 removing them to preserve vote independence"
            );
        }
        deduped
    }

    /// Warns (doesn't reject: distinct accounts/API keys on the same provider are a
    /// legitimate choice) when multiple entries across the combined `rpcUrls` +
    /// `additionalQuorumRpcUrls` pool share a host, grouped by index rather than the host
    /// itself so the log never reveals which provider it is. Exact-URL dedup alone misses
    /// this: different paths/API keys on the same host still share a failure domain (one
    /// provider outage or compromise counts as N votes).
    fn warn_if_duplicate_hosts(quorum_rpc_urls: &[Url]) {
        let mut indices_by_host: HashMap<Option<&str>, Vec<usize>> = HashMap::new();
        for (i, url) in quorum_rpc_urls.iter().enumerate() {
            indices_by_host.entry(url.host_str()).or_default().push(i);
        }
        let repeated_host_groups: Vec<Vec<usize>> = indices_by_host
            .into_values()
            .filter(|indices| indices.len() > 1)
            .collect();
        if !repeated_host_groups.is_empty() {
            warn!(
                ?repeated_host_groups,
                "rpcUrls/additionalQuorumRpcUrls have multiple entries (by index) sharing a host; \
                 they likely share a failure domain, weakening the independence the vote relies on"
            );
        }
    }

    /// Warns if the combined `rpcUrls` + `additionalQuorumRpcUrls` pool is too small to
    /// provide meaningful protection.
    fn warn_if_quorum_pool_undersized(quorum_rpc_urls: &[Url]) {
        if quorum_rpc_urls.len() < MIN_RECOMMENDED_QUORUM_RPCS {
            warn!(
                quorum_rpc_count = quorum_rpc_urls.len(),
                recommended_minimum = MIN_RECOMMENDED_QUORUM_RPCS,
                "the combined rpcUrls + additionalQuorumRpcUrls pool has very few entries and \
                 provides little to no real protection; consider adding more additionalQuorumRpcUrls entries"
            );
        }
    }

    async fn build_validator_quorum_merkle_tree_hook(
        base_hook: Arc<dyn MerkleTreeHook>,
        origin_chain_conf: &ChainConf,
        primary_rpc_urls: &[Url],
        additional_quorum_rpc_urls: &[Url],
        metrics: &CoreMetrics,
    ) -> ChainResult<Box<dyn MerkleTreeHook>> {
        let mut quorum_hooks = Self::build_validator_ethereum_per_url_hooks(
            origin_chain_conf,
            "rpcUrls",
            RpcRole::Primary,
            primary_rpc_urls,
            metrics,
        )
        .await?;
        quorum_hooks.extend(
            Self::build_validator_ethereum_per_url_hooks(
                origin_chain_conf,
                "additionalQuorumRpcUrls",
                RpcRole::Quorum,
                additional_quorum_rpc_urls,
                metrics,
            )
            .await?,
        );
        Ok(Box::new(ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook,
            quorum_hooks,
        }) as Box<dyn MerkleTreeHook>)
    }

    /// The actual URLs `base_hook` (`rpcUrls`) is configured with, read directly from
    /// `origin_chain_conf.connection` rather than `settings.rpcs` (which also comingles
    /// `grpcUrls`/`walletUrls`/`walletSolidityUrls`, used for non-Ethereum chains).
    fn primary_rpc_urls(origin_chain_conf: &ChainConf) -> Vec<Url> {
        let ChainConnectionConf::Ethereum(conn) = &origin_chain_conf.connection else {
            return Vec::new();
        };
        match &conn.rpc_connection {
            RpcConnectionConf::HttpQuorum { urls } | RpcConnectionConf::HttpFallback { urls } => {
                urls.clone()
            }
            RpcConnectionConf::Http { url } | RpcConnectionConf::Ws { url } => vec![url.clone()],
        }
    }

    /// Builds a per-URL connection, preserving the WebSocket variant for `ws`/`wss` URLs
    /// rather than always installing `Http`. A `ws://`/`wss://` primary forced into an
    /// `Http` connection would build an unusable hook - silently losing primary quorum
    /// availability for any validator configured with a WebSocket `rpcUrls` entry.
    fn ethereum_chain_conf_for_url(
        origin_chain_conf: &ChainConf,
        url: Url,
        role: RpcRole,
    ) -> ChainConf {
        let mut chain_conf = origin_chain_conf.clone();
        if let ChainConnectionConf::Ethereum(updated_conn) = &mut chain_conf.connection {
            updated_conn.rpc_connection = if matches!(url.scheme(), "ws" | "wss") {
                RpcConnectionConf::Ws { url }
            } else {
                RpcConnectionConf::Http { url }
            };
        }
        chain_conf.metrics_conf.rpc_role = role;
        chain_conf
    }

    /// Builds one single-URL `MerkleTreeHook` per entry in `urls`, labeled
    /// `{label_prefix}[i]` (by index, never by host/URL — some entries may be private
    /// RPCs, and even a redacted host can identify the provider, e.g. "alchemy.com") and
    /// tagged with `role` for the underlying connection's `rpc_role` Prometheus label.
    async fn build_validator_ethereum_per_url_hooks(
        origin_chain_conf: &ChainConf,
        label_prefix: &str,
        role: RpcRole,
        urls: &[Url],
        metrics: &CoreMetrics,
    ) -> ChainResult<Vec<(String, Arc<dyn MerkleTreeHook>)>> {
        let hooks = try_join_all(urls.iter().cloned().enumerate().map(|(i, url)| async move {
            Self::ethereum_chain_conf_for_url(origin_chain_conf, url, role)
                .build_merkle_tree_hook(metrics)
                .await
                .map(|hook| (format!("{label_prefix}[{i}]"), Arc::from(hook)))
        }))
        .await?;

        Ok(hooks)
    }

    /// Try to create merkle tree hook contract sync attempts times before giving up.
    async fn try_n_times_to_run_merkle_tree_hook_sync(
        &self,
        attempts: usize,
    ) -> eyre::Result<JoinHandle<()>> {
        for i in 0..attempts {
            let task = match self.run_merkle_tree_hook_sync().await {
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

    async fn run_merkle_tree_hook_sync(&self) -> eyre::Result<JoinHandle<()>> {
        let index_settings = self
            .as_ref()
            .settings
            .chains
            .get(&self.origin_chain)
            .map(|chain| chain.index_settings())
            .ok_or_else(|| eyre::eyre!("No index setting found"))?;
        let contract_sync = self.merkle_tree_hook_sync.clone();
        let cursor = contract_sync.cursor(index_settings).await?;
        let origin = self.origin_chain.name().to_string();

        let handle = tokio::spawn(
            async move {
                let label = "merkle_tree_hook";
                contract_sync.clone().sync(label, cursor.into()).await;
                info!(chain = origin, label, "contract sync task exit");
            }
            .instrument(info_span!("MerkleTreeHookSyncer")),
        );
        Ok(handle)
    }

    async fn run_checkpoint_submitters(&self) -> Vec<JoinHandle<()>> {
        let submitter = ValidatorSubmitter::new(
            self.interval,
            self.reorg_period.clone(),
            self.merkle_tree_hook.clone(),
            self.base_merkle_tree_hook.clone(),
            self.signer.clone(),
            self.raw_signer.clone(),
            self.checkpoint_syncer.clone(),
            Arc::new(self.db.clone()) as Arc<dyn HyperlaneDb>,
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain),
            self.max_sign_concurrency,
            self.reorg_reporter.clone(),
        );

        let tip_tree = call_and_retry_indefinitely(|| {
            let merkle_tree_hook = self.merkle_tree_hook.clone();
            let reorg_period = self.reorg_period.clone();
            Box::pin(async move { merkle_tree_hook.tree(&reorg_period).await })
        })
        .await;

        // This function is only called after we have already checked that the
        // merkle tree hook has count > 0, but we assert to be extra sure this is
        // the case.
        assert!(tip_tree.count() > 0, "merkle tree is empty");
        let backfill_target = submitter.checkpoint_at_block(&tip_tree);

        let backfill_submitter = submitter.clone();

        let mut tasks = vec![];
        tasks.push(tokio::spawn(
            async move {
                backfill_submitter
                    .backfill_checkpoint_submitter(backfill_target)
                    .await
            }
            .instrument(info_span!("BackfillCheckpointSubmitter")),
        ));

        tasks.push(tokio::spawn(
            async move { submitter.checkpoint_submitter(tip_tree.tree).await }
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
            mailbox_address: self.mailbox.address(),
            mailbox_domain: self.mailbox.domain().id(),
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
        let validators: [H256; 1] = [address.into()];
        loop {
            info!("Checking for validator announcement");
            if let Some(locations) = self
                .validator_announce
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
                    info!(eth_validator_address=?announcement.validator, ?chain_signer_string, ?chain_signer_h256, "Attempting self announce");

                    let balance_delta = self
                        .validator_announce
                        .announce_tokens_needed(signed_announcement.clone(), chain_signer_h256)
                        .await
                        .unwrap_or_default();
                    if balance_delta > U256::zero() {
                        warn!(
                            tokens_needed=%balance_delta,
                            eth_validator_address=?announcement.validator,
                            ?chain_signer_string,
                            ?chain_signer_h256,
                            "Please send tokens to your chain signer address to announce",
                        );
                    } else {
                        let result = self
                            .validator_announce
                            .announce(signed_announcement.clone())
                            .await;
                        Self::log_on_announce_failure(result, &chain_signer_string);
                    }
                } else {
                    warn!(origin_chain=%self.origin_chain, "Cannot announce validator without a signer; make sure a signer is set for the origin chain");
                }

                sleep(self.interval).await;
            }
        }
        Ok(())
    }

    async fn report_latest_checkpoints_from_each_endpoint(
        reorg_reporter: &Arc<dyn ReorgReporter>,
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
    use async_trait::async_trait;
    use hyperlane_core::{test_utils::dummy_domain, HyperlaneProvider};
    use prometheus::Registry;

    use super::*;

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
    fn validator_uses_split_quorum_hook_requires_nonempty_quorum_urls() {
        let chain_conf =
            dummy_ethereum_chain_conf(vec![Url::parse("http://normal.example").unwrap()]);

        assert!(!Validator::validator_uses_split_quorum_hook(
            &chain_conf,
            &[]
        ));

        let additional_quorum_urls = vec![Url::parse("http://quorum-a.example").unwrap()];
        assert!(Validator::validator_uses_split_quorum_hook(
            &chain_conf,
            &additional_quorum_urls
        ));
    }

    #[test]
    fn dedupe_additional_quorum_rpc_urls_removes_exact_duplicates_preserving_order() {
        let urls = vec![
            Url::parse("http://rpc-a.example").unwrap(),
            Url::parse("http://rpc-b.example").unwrap(),
            Url::parse("http://rpc-a.example").unwrap(),
            Url::parse("http://rpc-c.example").unwrap(),
        ];

        let deduped = Validator::dedupe_additional_quorum_rpc_urls(urls);

        assert_eq!(
            deduped,
            vec![
                Url::parse("http://rpc-a.example").unwrap(),
                Url::parse("http://rpc-b.example").unwrap(),
                Url::parse("http://rpc-c.example").unwrap(),
            ]
        );
    }

    #[test]
    fn dedupe_additional_quorum_rpc_urls_is_noop_without_duplicates() {
        let urls = vec![
            Url::parse("http://rpc-a.example").unwrap(),
            Url::parse("http://rpc-b.example").unwrap(),
        ];

        let deduped = Validator::dedupe_additional_quorum_rpc_urls(urls.clone());

        assert_eq!(deduped, urls);
    }

    /// Regression test for the cross-pool double-vote: `rpcUrls=[P]` plus
    /// `additionalQuorumRpcUrls=[P, H]` must not let `P` cast two votes. A compromised `P`
    /// would otherwise supply the 2/3 quorum majority by itself (via its Primary-tagged and
    /// Quorum-tagged hooks both agreeing) *and* the agreeing `base_hook`, despite only one
    /// of the two nominally-independent endpoints actually being compromised.
    #[test]
    fn remove_urls_already_in_primary_removes_cross_pool_overlap() {
        let primary = Url::parse("http://p.example").unwrap();
        let honest = Url::parse("http://h.example").unwrap();
        let primary_rpc_urls = vec![primary.clone()];
        let additional_quorum_rpc_urls = vec![primary.clone(), honest.clone()];

        let deduped = Validator::remove_urls_already_in_primary(
            &primary_rpc_urls,
            additional_quorum_rpc_urls,
        );

        assert_eq!(deduped, vec![honest]);
    }

    #[test]
    fn remove_urls_already_in_primary_is_noop_without_overlap() {
        let primary_rpc_urls = vec![Url::parse("http://p.example").unwrap()];
        let additional_quorum_rpc_urls = vec![Url::parse("http://h.example").unwrap()];

        let deduped = Validator::remove_urls_already_in_primary(
            &primary_rpc_urls,
            additional_quorum_rpc_urls.clone(),
        );

        assert_eq!(deduped, additional_quorum_rpc_urls);
    }

    #[test]
    fn primary_rpc_urls_extracts_from_http_fallback() {
        let urls = vec![
            Url::parse("http://rpc-a.example").unwrap(),
            Url::parse("http://rpc-b.example").unwrap(),
        ];
        let chain_conf = dummy_ethereum_chain_conf(urls.clone());

        assert_eq!(Validator::primary_rpc_urls(&chain_conf), urls);
    }

    #[test]
    fn primary_rpc_urls_extracts_from_single_http() {
        let mut chain_conf = dummy_ethereum_chain_conf(vec![]);
        let url = Url::parse("http://rpc-a.example").unwrap();
        if let ChainConnectionConf::Ethereum(conn) = &mut chain_conf.connection {
            conn.rpc_connection = RpcConnectionConf::Http { url: url.clone() };
        }

        assert_eq!(Validator::primary_rpc_urls(&chain_conf), vec![url]);
    }

    #[test]
    #[tracing_test::traced_test]
    fn warn_if_quorum_pool_undersized_warns_below_minimum() {
        let urls = vec![Url::parse("http://rpc-a.example").unwrap()];

        Validator::warn_if_quorum_pool_undersized(&urls);

        assert!(logs_contain(
            "combined rpcUrls + additionalQuorumRpcUrls pool has very few entries"
        ));
    }

    #[test]
    #[tracing_test::traced_test]
    fn warn_if_quorum_pool_undersized_silent_at_or_above_minimum() {
        let urls = vec![
            Url::parse("http://rpc-a.example").unwrap(),
            Url::parse("http://rpc-b.example").unwrap(),
            Url::parse("http://rpc-c.example").unwrap(),
        ];

        Validator::warn_if_quorum_pool_undersized(&urls);

        assert!(!logs_contain(
            "combined rpcUrls + additionalQuorumRpcUrls pool has very few entries"
        ));
    }

    #[test]
    #[tracing_test::traced_test]
    fn warn_if_duplicate_hosts_warns_on_shared_host() {
        let urls = vec![
            Url::parse("http://shared.example/key-a").unwrap(),
            Url::parse("http://other.example").unwrap(),
            Url::parse("http://shared.example/key-b").unwrap(),
        ];

        Validator::warn_if_duplicate_hosts(&urls);

        assert!(logs_contain(
            "rpcUrls/additionalQuorumRpcUrls have multiple entries (by index) sharing a host"
        ));
    }

    #[test]
    #[tracing_test::traced_test]
    fn warn_if_duplicate_hosts_silent_when_all_distinct() {
        let urls = vec![
            Url::parse("http://rpc-a.example").unwrap(),
            Url::parse("http://rpc-b.example").unwrap(),
        ];

        Validator::warn_if_duplicate_hosts(&urls);

        assert!(!logs_contain(
            "rpcUrls/additionalQuorumRpcUrls have multiple entries (by index) sharing a host"
        ));
    }

    #[test]
    fn ethereum_chain_conf_for_url_uses_single_http_connection() {
        let chain_conf = dummy_ethereum_chain_conf(vec![
            Url::parse("http://rpc-a.example").unwrap(),
            Url::parse("http://rpc-b.example").unwrap(),
        ]);
        let url = Url::parse("http://quorum-node.example").unwrap();

        let per_url_conf =
            Validator::ethereum_chain_conf_for_url(&chain_conf, url.clone(), RpcRole::Quorum);

        match per_url_conf.connection {
            ChainConnectionConf::Ethereum(conn) => match conn.rpc_connection {
                RpcConnectionConf::Http { url: got } => assert_eq!(got, url),
                other => panic!("expected a single Http connection, got {other:?}"),
            },
            _ => panic!("expected an ethereum connection"),
        }
        assert_eq!(per_url_conf.metrics_conf.rpc_role, RpcRole::Quorum);
    }

    /// Regression test: a `ws://`/`wss://` URL must build a `Ws` connection, not `Http` -
    /// forcing it into `Http` would build an unusable hook, silently losing primary quorum
    /// availability for any validator configured with a WebSocket `rpcUrls` entry.
    #[test]
    fn ethereum_chain_conf_for_url_preserves_websocket_connection() {
        let chain_conf =
            dummy_ethereum_chain_conf(vec![Url::parse("http://rpc-a.example").unwrap()]);
        let url = Url::parse("wss://quorum-node.example").unwrap();

        let per_url_conf =
            Validator::ethereum_chain_conf_for_url(&chain_conf, url.clone(), RpcRole::Primary);

        match per_url_conf.connection {
            ChainConnectionConf::Ethereum(conn) => match conn.rpc_connection {
                RpcConnectionConf::Ws { url: got } => assert_eq!(got, url),
                other => panic!("expected a Ws connection, got {other:?}"),
            },
            _ => panic!("expected an ethereum connection"),
        }
        assert_eq!(per_url_conf.metrics_conf.rpc_role, RpcRole::Primary);
    }

    #[tokio::test]
    async fn build_validator_ethereum_per_url_hooks_produces_one_hook_per_url() {
        let chain_conf =
            dummy_ethereum_chain_conf(vec![Url::parse("http://normal-rpc.example").unwrap()]);
        let urls = vec![
            Url::parse("http://quorum-a.example").unwrap(),
            Url::parse("http://quorum-b.example").unwrap(),
            Url::parse("http://quorum-c.example").unwrap(),
        ];
        let metrics = CoreMetrics::new(
            "validator-test-ethereum-quorum-hooks",
            9091,
            Registry::new(),
        )
        .unwrap();

        let hooks = Validator::build_validator_ethereum_per_url_hooks(
            &chain_conf,
            "additionalQuorumRpcUrls",
            RpcRole::Quorum,
            &urls,
            &metrics,
        )
        .await
        .unwrap();

        assert_eq!(hooks.len(), 3);
        let labels: Vec<&str> = hooks.iter().map(|(label, _)| label.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "additionalQuorumRpcUrls[0]",
                "additionalQuorumRpcUrls[1]",
                "additionalQuorumRpcUrls[2]"
            ]
        );
    }

    mockall::mock! {
        pub MerkleTreeHook {}

        impl Debug for MerkleTreeHook {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        impl HyperlaneChain for MerkleTreeHook {
            fn domain(&self) -> &HyperlaneDomain;
            fn provider(&self) -> Box<dyn HyperlaneProvider>;
        }

        impl HyperlaneContract for MerkleTreeHook {
            fn address(&self) -> H256;
        }

        #[async_trait]
        impl MerkleTreeHook for MerkleTreeHook {
            async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock>;
            async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32>;
            async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<CheckpointAtBlock>;
            async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock>;
            async fn tree_at_block(&self, height: u64) -> ChainResult<IncrementalMerkleAtBlock>;
        }
    }

    fn quorum_rpc(label: &str, hook: MockMerkleTreeHook) -> (String, Arc<dyn MerkleTreeHook>) {
        (label.to_string(), Arc::new(hook) as Arc<dyn MerkleTreeHook>)
    }

    #[test]
    fn two_thirds_threshold_rounds_up() {
        // ceil(2n/3): e.g. 2 of 3, 3 of 4, 4 of 5, 4 of 6.
        let expected = [(0, 0), (1, 1), (2, 2), (3, 2), (4, 3), (5, 4), (6, 4)];
        for (n, threshold) in expected {
            assert_eq!(
                ValidatorMultiRpcQuorumMerkleTreeHook::two_thirds_threshold(n),
                threshold,
                "n={n}"
            );
        }
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

    /// A resolved checkpoint used purely to pin quorum reads to a shared height; its
    /// checkpoint value is irrelevant, only `block_height` is consumed.
    fn height_resolution_checkpoint(mailbox_domain: u32, height: u64) -> CheckpointAtBlock {
        CheckpointAtBlock {
            checkpoint: hyperlane_core::Checkpoint {
                merkle_tree_hook_address: H256::from_low_u64_be(11),
                mailbox_domain,
                root: H256::zero(),
                index: 0,
            },
            block_height: Some(height),
        }
    }

    /// `resolve_quorum_target_height` resolves via `base_hook.latest_checkpoint()`.
    fn mock_height_resolution(hook: &mut MockMerkleTreeHook, mailbox_domain: u32, height: u64) {
        hook.expect_latest_checkpoint()
            .once()
            .return_once(move |_| Ok(height_resolution_checkpoint(mailbox_domain, height)));
    }

    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_count_uses_base_hook_only() {
        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().once().return_once(|_| Ok(3));
        base_hook.expect_tree().never();
        base_hook.expect_tree_at_block().never();
        base_hook.expect_latest_checkpoint().never();
        base_hook.expect_latest_checkpoint_at_block().never();

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![],
        };

        assert_eq!(hook.count(&ReorgPeriod::None).await.unwrap(), 3);
    }

    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_reaches_two_thirds_and_agrees_with_base_hook(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();
        let expected_tree = IncrementalMerkleAtBlock {
            tree: Default::default(),
            block_height: Some(50),
        };
        let mut divergent_merkle =
            hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
        divergent_merkle.ingest(H256::from_low_u64_be(1));
        let divergent_tree = IncrementalMerkleAtBlock {
            tree: divergent_merkle,
            block_height: Some(50),
        };

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 50);
        base_hook
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let expected_tree = expected_tree.clone();
                move |_| Ok(expected_tree)
            });

        // 2 of 3 (>= two_thirds_threshold(3) == 2) is enough for the quorum_hooks vote, and
        // that value matches base_hook's own result.
        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_latest_checkpoint().never();
        quorum_a
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let expected_tree = expected_tree.clone();
                move |_| Ok(expected_tree)
            });

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| Ok(expected_tree));

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_latest_checkpoint().never();
        quorum_c
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| Ok(divergent_tree));

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-a", quorum_a),
                quorum_rpc("rpc-b", quorum_b),
                quorum_rpc("rpc-c", quorum_c),
            ],
        };

        assert_eq!(
            hook.tree(&ReorgPeriod::None).await.unwrap().block_height,
            Some(50)
        );
    }

    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_fails_when_quorum_hooks_dont_reach_two_thirds(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        // Never reached: the quorum_hooks vote fails before base_hook would be consulted.
        base_hook.expect_tree_at_block().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 5);

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_latest_checkpoint().never();
        quorum_a
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(5))
            .return_once(|_| {
                Ok(IncrementalMerkleAtBlock {
                    tree: Default::default(),
                    block_height: Some(5),
                })
            });

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(5))
            .return_once(|_| {
                let mut divergent =
                    hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
                divergent.ingest(H256::from_low_u64_be(1));
                Ok(IncrementalMerkleAtBlock {
                    tree: divergent,
                    block_height: Some(5),
                })
            });

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_latest_checkpoint().never();
        quorum_c
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(5))
            .return_once(|_| {
                let mut divergent =
                    hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
                divergent.ingest(H256::from_low_u64_be(2));
                Ok(IncrementalMerkleAtBlock {
                    tree: divergent,
                    block_height: Some(5),
                })
            });

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-a", quorum_a),
                quorum_rpc("rpc-b", quorum_b),
                quorum_rpc("rpc-c", quorum_c),
            ],
        };

        assert!(hook.tree(&ReorgPeriod::None).await.is_err());
    }

    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_tolerates_rpc_failure_within_two_thirds_threshold(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();
        let expected_tree = IncrementalMerkleAtBlock {
            tree: Default::default(),
            block_height: Some(11),
        };

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 11);
        base_hook
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(11))
            .return_once({
                let expected_tree = expected_tree.clone();
                move |_| Ok(expected_tree)
            });

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_latest_checkpoint().never();
        quorum_a
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(11))
            .return_once({
                let expected_tree = expected_tree.clone();
                move |_| Ok(expected_tree)
            });

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(11))
            .return_once(|_| Err(ChainCommunicationError::from_other_str("boom")));

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_latest_checkpoint().never();
        quorum_c
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(11))
            .return_once(move |_| Ok(expected_tree));

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-a", quorum_a),
                quorum_rpc("rpc-b", quorum_b),
                quorum_rpc("rpc-c", quorum_c),
            ],
        };

        assert_eq!(
            hook.tree(&ReorgPeriod::None).await.unwrap().block_height,
            Some(11)
        );
    }

    /// `quorum_hooks` unanimously agree on tree_x, but `base_hook` (the separate `rpcUrls`
    /// pool) returns tree_y. Agreeing within `quorum_hooks` alone isn't enough: an
    /// attacker would also need to compromise the independent `rpcUrls` pool.
    #[tokio::test]
    #[tracing_test::traced_test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_fails_when_quorum_agrees_but_base_hook_disagrees(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();
        let quorum_tree = IncrementalMerkleAtBlock {
            tree: Default::default(),
            block_height: Some(50),
        };
        let mut base_merkle =
            hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
        base_merkle.ingest(H256::from_low_u64_be(1));
        let base_tree = IncrementalMerkleAtBlock {
            tree: base_merkle,
            block_height: Some(50),
        };

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 50);
        base_hook
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| Ok(base_tree));

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_latest_checkpoint().never();
        quorum_a
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let quorum_tree = quorum_tree.clone();
                move |_| Ok(quorum_tree)
            });

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let quorum_tree = quorum_tree.clone();
                move |_| Ok(quorum_tree)
            });

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_latest_checkpoint().never();
        quorum_c
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| Ok(quorum_tree));

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-a", quorum_a),
                quorum_rpc("rpc-b", quorum_b),
                quorum_rpc("rpc-c", quorum_c),
            ],
        };

        assert!(hook.tree(&ReorgPeriod::None).await.is_err());
        assert!(logs_contain(
            "merged quorum consensus disagrees with rpcUrls consensus"
        ));
    }

    /// Observability regression test: a `Primary` (`rpcUrls`) entry failing must still be
    /// logged even when the round succeeds via the other entries - this is a pure
    /// observability signal, separate from (and must not reintroduce) any
    /// denominator-exclusion logic. 1 failed `rpcUrls` entry + 2 agreeing
    /// `additionalQuorumRpcUrls` entries meets the 2/3-of-3 threshold, so the round succeeds,
    /// but ops should still be warned that an `rpcUrls` entry is unhealthy.
    #[tokio::test]
    #[tracing_test::traced_test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_warns_on_primary_failure_in_successful_round(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();
        let quorum_tree = IncrementalMerkleAtBlock {
            tree: Default::default(),
            block_height: Some(50),
        };

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 50);
        base_hook
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let quorum_tree = quorum_tree.clone();
                move |_| Ok(quorum_tree)
            });

        let mut primary_failing = MockMerkleTreeHook::new();
        primary_failing.expect_latest_checkpoint().never();
        primary_failing
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(|_| Err(ChainCommunicationError::from_other_str("rpc down")));

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_latest_checkpoint().never();
        quorum_a
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let quorum_tree = quorum_tree.clone();
                move |_| Ok(quorum_tree)
            });

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| Ok(quorum_tree));

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpcUrls[0]", primary_failing),
                quorum_rpc("additionalQuorumRpcUrls[0]", quorum_a),
                quorum_rpc("additionalQuorumRpcUrls[1]", quorum_b),
            ],
        };

        assert!(hook.tree(&ReorgPeriod::None).await.is_ok());
        assert!(logs_contain(
            "rpcUrls entries failed this round; they still count against the quorum threshold"
        ));
    }

    /// Regression test for the tip-relative-comparison bug: honest quorum RPCs that all
    /// agree on the tree content but disagree on their own self-reported `block_height`
    /// (as happens if the equality check compares heights instead of relying purely on
    /// the pinned-height call) must still reach quorum, not falsely disagree.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tolerates_differing_self_reported_block_height(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();
        let tree_content = IncrementalMerkleAtBlock {
            tree: Default::default(),
            block_height: Some(50),
        };

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 50);
        base_hook
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let tree = tree_content.tree.clone();
                move |_| {
                    Ok(IncrementalMerkleAtBlock {
                        tree,
                        block_height: Some(53),
                    })
                }
            });

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_latest_checkpoint().never();
        quorum_a
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let tree = tree_content.tree.clone();
                move |_| {
                    Ok(IncrementalMerkleAtBlock {
                        tree,
                        block_height: Some(50),
                    })
                }
            });

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let tree = tree_content.tree.clone();
                // Same tree content, but a differing self-reported block_height.
                move |_| {
                    Ok(IncrementalMerkleAtBlock {
                        tree,
                        block_height: Some(51),
                    })
                }
            });

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_latest_checkpoint().never();
        quorum_c
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| {
                Ok(IncrementalMerkleAtBlock {
                    tree: tree_content.tree,
                    block_height: Some(52),
                })
            });

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-a", quorum_a),
                quorum_rpc("rpc-b", quorum_b),
                quorum_rpc("rpc-c", quorum_c),
            ],
        };

        assert!(hook.tree(&ReorgPeriod::None).await.is_ok());
    }

    /// Builds an `IncrementalMerkle` with `count` leaves, giving a concrete root/index to
    /// assert quorum agreement/disagreement against.
    fn tree_with_count(count: u32) -> hyperlane_core::accumulator::incremental::IncrementalMerkle {
        let mut tree = hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
        for i in 0..count {
            tree.ingest(H256::from_low_u64_be(i as u64 + 1));
        }
        tree
    }

    /// Regression test: the on-chain `latestCheckpoint()` call this replaces reverts
    /// (`count() - 1` underflow under Solidity's checked arithmetic) rather than succeeding
    /// on an empty tree. `checkpoint_from_tree` must surface that as a `ChainResult::Err`,
    /// not panic via `IncrementalMerkle::index()`'s internal assert.
    #[test]
    fn checkpoint_from_tree_errors_on_empty_tree_instead_of_panicking() {
        let empty_tree = IncrementalMerkleAtBlock {
            tree: tree_with_count(0),
            block_height: Some(10),
        };

        let result = ValidatorMultiRpcQuorumMerkleTreeHook::checkpoint_from_tree(
            empty_tree,
            H256::from_low_u64_be(11),
            1337,
        );

        assert!(result.is_err());
    }

    #[test]
    fn checkpoint_from_tree_derives_checkpoint_from_nonempty_tree() {
        let tree = tree_with_count(5);
        let expected_root = tree.root();

        let result = ValidatorMultiRpcQuorumMerkleTreeHook::checkpoint_from_tree(
            IncrementalMerkleAtBlock {
                tree,
                block_height: Some(10),
            },
            H256::from_low_u64_be(11),
            1337,
        )
        .unwrap();

        assert_eq!(result.checkpoint.index, 4);
        assert_eq!(result.checkpoint.root, expected_root);
        assert_eq!(
            result.checkpoint.merkle_tree_hook_address,
            H256::from_low_u64_be(11)
        );
        assert_eq!(result.checkpoint.mailbox_domain, 1337);
        assert_eq!(result.block_height, Some(10));
    }

    /// `latest_checkpoint`/`latest_checkpoint_at_block` must never independently call
    /// `quorum_hooks`/`base_hook`'s `latest_checkpoint*` methods (asserted via `.never()`
    /// below): the checkpoint is derived locally from a quorum-verified `tree` read, so the
    /// public-RPC-inclusive `quorum_hooks` pool is only ever exercised for root reads. Also
    /// proves `latest_checkpoint()` correctly resolves a height (via `base_hook`) and
    /// delegates to the same quorum machinery as `tree()`.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_uses_quorum_for_latest_checkpoint() {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();
        let agreed_tree = tree_with_count(8);
        let divergent_tree = tree_with_count(9);

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 99);
        base_hook
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        base_hook
            .expect_domain()
            .return_const(dummy_domain(1337, "test-domain"));
        base_hook
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(99))
            .return_once({
                let tree = agreed_tree.clone();
                move |_| {
                    Ok(IncrementalMerkleAtBlock {
                        tree,
                        block_height: Some(99),
                    })
                }
            });

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_latest_checkpoint().never();
        quorum_a.expect_latest_checkpoint_at_block().never();
        quorum_a
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(99))
            .return_once({
                let tree = agreed_tree.clone();
                move |_| {
                    Ok(IncrementalMerkleAtBlock {
                        tree,
                        block_height: Some(99),
                    })
                }
            });

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b.expect_latest_checkpoint_at_block().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(99))
            .return_once(move |_| {
                Ok(IncrementalMerkleAtBlock {
                    tree: agreed_tree,
                    block_height: Some(99),
                })
            });

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_latest_checkpoint().never();
        quorum_c.expect_latest_checkpoint_at_block().never();
        quorum_c
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(99))
            .return_once(move |_| {
                Ok(IncrementalMerkleAtBlock {
                    tree: divergent_tree,
                    block_height: Some(99),
                })
            });

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-a", quorum_a),
                quorum_rpc("rpc-b", quorum_b),
                quorum_rpc("rpc-c", quorum_c),
            ],
        };

        assert_eq!(
            hook.latest_checkpoint(&ReorgPeriod::None)
                .await
                .unwrap()
                .checkpoint
                .index,
            7
        );
    }

    /// Same guarantee as above (quorum only ever exercised via `tree_at_block`), for the
    /// explicit-height entry point.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_latest_checkpoint_at_block_uses_quorum() {
        let agreed_tree = tree_with_count(9);
        let divergent_tree = tree_with_count(10);

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_latest_checkpoint().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        base_hook
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        base_hook
            .expect_domain()
            .return_const(dummy_domain(1337, "test-domain"));
        base_hook
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once({
                let tree = agreed_tree.clone();
                move |height| {
                    Ok(IncrementalMerkleAtBlock {
                        tree,
                        block_height: Some(height),
                    })
                }
            });

        let make_hook = |tree: hyperlane_core::accumulator::incremental::IncrementalMerkle| {
            let mut hook = MockMerkleTreeHook::new();
            hook.expect_latest_checkpoint().never();
            hook.expect_latest_checkpoint_at_block().never();
            hook.expect_tree_at_block()
                .once()
                .with(mockall::predicate::eq(42))
                .return_once(move |height| {
                    Ok(IncrementalMerkleAtBlock {
                        tree,
                        block_height: Some(height),
                    })
                });
            hook
        };

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-a", make_hook(agreed_tree.clone())),
                quorum_rpc("rpc-b", make_hook(agreed_tree)),
                quorum_rpc("rpc-c", make_hook(divergent_tree)),
            ],
        };

        assert_eq!(
            hook.latest_checkpoint_at_block(42)
                .await
                .unwrap()
                .checkpoint
                .index,
            8
        );
    }

    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tag_reorg_period_falls_back_to_unpinned_tree_reads(
    ) {
        let tag_period = ReorgPeriod::Tag("finalized".to_string());
        let expected_tree = IncrementalMerkleAtBlock {
            tree: Default::default(),
            // Tag-based periods don't resolve to an explicit height.
            block_height: None,
        };

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree_at_block().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        base_hook
            .expect_latest_checkpoint()
            .once()
            .return_once(|_| {
                Ok(CheckpointAtBlock {
                    checkpoint: hyperlane_core::Checkpoint {
                        merkle_tree_hook_address: H256::from_low_u64_be(11),
                        mailbox_domain: 1337,
                        root: H256::zero(),
                        index: 0,
                    },
                    block_height: None,
                })
            });
        base_hook.expect_tree().once().return_once({
            let expected_tree = expected_tree.clone();
            move |_| Ok(expected_tree)
        });

        let make_hook = |tree: IncrementalMerkleAtBlock| {
            let mut hook = MockMerkleTreeHook::new();
            hook.expect_latest_checkpoint().never();
            hook.expect_tree_at_block().never();
            hook.expect_tree().once().return_once(move |_| Ok(tree));
            hook
        };

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-a", make_hook(expected_tree.clone())),
                quorum_rpc("rpc-b", make_hook(expected_tree.clone())),
                quorum_rpc("rpc-c", make_hook(expected_tree)),
            ],
        };

        assert!(hook.tree(&tag_period).await.is_ok());
    }
}
