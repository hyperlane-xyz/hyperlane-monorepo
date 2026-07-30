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
    Announcement, ChainCommunicationError, ChainResult, CheckpointAtBlock, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneSigner, HyperlaneSignerExt,
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

/// Below this, the combined `rpcUrls` + `additionalQuorumRpcUrls` pool gives little to no real
/// protection: with 1 entry any value trivially reaches quorum, and with 2 entries all
/// must unanimously agree.
const MIN_RECOMMENDED_QUORUM_RPCS: usize = 3;

/// `count()`/domain/address come from `base_hook` (the normal `rpcUrls` connection, using
/// whatever consensus mode it's configured with). `base_hook` is also used to resolve a
/// canonical block height that every vote below is pinned to
/// (`resolve_quorum_target_height`).
///
/// `tree()`/`latest_checkpoint()`/`latest_checkpoint_at_block()` instead run a single 2/3
/// majority vote across `quorum_hooks`: one hook per `rpcUrls` entry (role `Primary`) plus
/// one hook per `additionalQuorumRpcUrls` entry (role `Quorum`). The threshold's
/// denominator is always the full configured `quorum_hooks` pool size — a failed entry,
/// `Primary` or `Quorum`, is always counted against it, never excluded (see
/// `select_quorum_result` for why: every "exclude an unavailable `Quorum`-role entry"
/// heuristic tried here turned out to have a fail-open bypass). Tolerating an
/// `additionalQuorumRpcUrls` blip therefore comes from over-provisioning the pool size
/// (see `MIN_RECOMMENDED_QUORUM_RPCS`/`warn_if_quorum_pool_undersized`), not from
/// excluding failures after the fact. The merged vote's winner must also independently
/// match what `base_hook` (`rpcUrls`'s own consensus) returns — see
/// `require_base_hook_agreement` — so a colluding or compromised subset of the merged
/// group (most plausibly `additionalQuorumRpcUrls`, being public) can't outvote an
/// honest `Primary`.
#[derive(Debug)]
struct ValidatorMultiRpcQuorumMerkleTreeHook {
    base_hook: Arc<dyn MerkleTreeHook>,
    quorum_hooks: Vec<QuorumHook>,
}

/// A single per-URL vote in the merged `rpcUrls` + `additionalQuorumRpcUrls` quorum group.
#[derive(Debug, Clone)]
struct QuorumHook {
    /// `rpcUrls[i]`/`additionalQuorumRpcUrls[i]` index label (0-based), not the host/URL itself —
    /// some entries may be private RPCs, so logging which one disagreed must never reveal
    /// which URL/provider that is.
    label: String,
    /// Whether this came from `rpcUrls` (`Primary`) or `additionalQuorumRpcUrls` (`Quorum`) — also
    /// tags the underlying connection's `rpc_role` Prometheus label, so `Quorum`-role
    /// failures (expected/tolerated) can be distinguished from `Primary`-role ones in
    /// metrics/alerting.
    role: RpcRole,
    hook: Arc<dyn MerkleTreeHook>,
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
    ///
    /// The threshold's denominator is always the full configured `quorum_hooks` pool
    /// size (`self.quorum_hooks.len()`) — a failed entry, whether `Primary`-role (an
    /// `rpcUrls` entry) or `Quorum`-role (an `additionalQuorumRpcUrls` entry), always
    /// still counts against it and is never excluded. Earlier revisions tried excluding
    /// unavailable `Quorum`-role entries from the denominator so a blip wouldn't force
    /// near-unanimous agreement among the rest, gated on some cheap signal (whether at
    /// least one, or later a 2/3 majority, of the `Quorum`-role pool responded this
    /// round). Every such signal turned out to have a fail-open bypass: a compromised
    /// `Primary` can manipulate the target height so only a colluding minority of
    /// `additionalQuorumRpcUrls` answers while the honest majority correctly errors "not
    /// found" — and response/agreement counts alone can't reliably tell that apart from
    /// a genuine blip. Keeping the denominator fixed removes the exploit entirely:
    /// tolerating expected `additionalQuorumRpcUrls` blips instead comes from
    /// over-provisioning the pool size (see `MIN_RECOMMENDED_QUORUM_RPCS` /
    /// `warn_if_quorum_pool_undersized`), not from excluding failures after the fact.
    ///
    /// A `Quorum`-role RPC's error also never becomes the round's returned error (see
    /// `first_primary_err` below): metrics/alerting should surface unexpected
    /// `Primary`-role failures, not additional-quorum blips.
    fn select_quorum_result<T: Clone + Debug>(
        &self,
        results: Vec<(String, RpcRole, ChainResult<T>)>,
        matches: impl Fn(&T, &T) -> bool,
        context: &str,
    ) -> ChainResult<T> {
        let mut oks: Vec<(String, T)> = Vec::new();
        // Only ever populated from a Primary-role failure: a Quorum-role entry failing is
        // expected/tolerated, so its error must never surface as the round's returned
        // error (which callers log at `error!`/`warn!`, i.e. this is the one place that
        // failure could otherwise leak out).
        let mut first_primary_err = None;
        let mut failed_quorum_rpcs: Vec<String> = Vec::new();
        let mut failed_primary_rpcs: Vec<String> = Vec::new();

        for (label, role, result) in results {
            match result {
                Ok(value) => oks.push((label, value)),
                Err(err) => {
                    if role == RpcRole::Quorum {
                        failed_quorum_rpcs.push(label);
                    } else {
                        failed_primary_rpcs.push(label);
                        if first_primary_err.is_none() {
                            first_primary_err = Some(err);
                        }
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
        if !failed_quorum_rpcs.is_empty() {
            debug!(
                context,
                failed_quorum_rpcs = ?failed_quorum_rpcs,
                "additionalQuorumRpcUrls entries failed this round; they still count against the quorum threshold"
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
            // Prefer a Primary-role RPC's error; if every quorum_hooks entry that failed
            // was Quorum-role, fall back to a generic message rather than surfacing that
            // RPC's error verbatim.
            return Err(first_primary_err
                .unwrap_or_else(|| ChainCommunicationError::from_other_str(context)));
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
    /// honest `Primary`: e.g. 1 honest `rpcUrls` entry plus 2 colluding public
    /// `additionalQuorumRpcUrls` entries reach the overall 2/3 threshold on the public
    /// pair's value alone. An attacker now also has to compromise `rpcUrls`' own
    /// consensus to force a wrong value through.
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
}

#[async_trait]
impl MerkleTreeHook for ValidatorMultiRpcQuorumMerkleTreeHook {
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        if let Some(height) = self.resolve_quorum_target_height(reorg_period).await? {
            let results = join_all(self.quorum_hooks.iter().cloned().map(
                |quorum_hook| async move {
                    (
                        quorum_hook.label,
                        quorum_hook.role,
                        Self::with_call_timeout(quorum_hook.hook.tree_at_block(height)).await,
                    )
                },
            ))
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
            return Ok(quorum_result);
        }

        let results = join_all(self.quorum_hooks.iter().cloned().map(|quorum_hook| {
            let reorg_period = reorg_period.clone();
            async move {
                (
                    quorum_hook.label,
                    quorum_hook.role,
                    Self::with_call_timeout(quorum_hook.hook.tree(&reorg_period)).await,
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
        if let Some(height) = self.resolve_quorum_target_height(reorg_period).await? {
            return self.latest_checkpoint_at_block(height).await;
        }

        let results = join_all(self.quorum_hooks.iter().cloned().map(|quorum_hook| {
            let reorg_period = reorg_period.clone();
            async move {
                (
                    quorum_hook.label,
                    quorum_hook.role,
                    Self::with_call_timeout(quorum_hook.hook.latest_checkpoint(&reorg_period))
                        .await,
                )
            }
        }))
        .await;
        let quorum_result = self.select_quorum_result(
            results,
            |a, b| a.checkpoint == b.checkpoint && a.block_height == b.block_height,
            "Failed to reach quorum for latest_checkpoint",
        )?;
        let base_result = self.base_hook.latest_checkpoint(reorg_period).await?;
        Self::require_base_hook_agreement(
            &quorum_result,
            &base_result,
            |a, b| a.checkpoint == b.checkpoint,
            "Failed to reach quorum for latest_checkpoint",
        )?;
        Ok(quorum_result)
    }

    async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock> {
        let results = join_all(
            self.quorum_hooks
                .iter()
                .cloned()
                .map(|quorum_hook| async move {
                    (
                        quorum_hook.label,
                        quorum_hook.role,
                        Self::with_call_timeout(
                            quorum_hook.hook.latest_checkpoint_at_block(height),
                        )
                        .await,
                    )
                }),
        )
        .await;
        let quorum_result = self.select_quorum_result(
            results,
            |a, b| a.checkpoint == b.checkpoint && a.block_height == b.block_height,
            "Failed to reach quorum for latest_checkpoint_at_block",
        )?;
        let base_result = self.base_hook.latest_checkpoint_at_block(height).await?;
        Self::require_base_hook_agreement(
            &quorum_result,
            &base_result,
            |a, b| a.checkpoint == b.checkpoint,
            "Failed to reach quorum for latest_checkpoint_at_block",
        )?;
        Ok(quorum_result)
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
        let additional_quorum_rpc_urls: Vec<(Url, bool)> = Self::dedupe_additional_quorum_rpc_urls(
            settings
                .additional_quorum_rpcs
                .iter()
                .enumerate()
                .map(|(i, rpc)| {
                    // Identify the entry by index, never by the URL itself: it may embed
                    // an API key, and a parse failure (e.g. a typo) is exactly the case
                    // where the URL is most likely to end up copied verbatim into logs.
                    Url::parse(&rpc.url)
                        .map(|url| (url, rpc.public))
                        .map_err(|err| eyre!("Invalid additionalQuorumRpcUrls[{i}] entry: {err}"))
                })
                .collect::<Result<_>>()?,
        );

        let mailbox = origin_chain_conf.build_mailbox(&metrics).await?;

        let merkle_tree_hook = if Self::validator_uses_split_quorum_hook(
            &origin_chain_conf,
            &additional_quorum_rpc_urls,
        ) {
            // `rpcUrls` (`primary_rpc_urls` below) votes alongside `additionalQuorumRpcUrls` in the
            // same 2/3 quorum group (see `ValidatorMultiRpcQuorumMerkleTreeHook`), so
            // `additionalQuorumRpcUrls` only needs to add public endpoints on top of it.
            //
            // Read directly from `origin_chain_conf.connection` rather than `settings.rpcs`:
            // `settings.rpcs` also comingles `grpcUrls`/`walletUrls`/`walletSolidityUrls`
            // entries (used for non-Ethereum chains), which would otherwise leak into the
            // `Primary` vote pool as URLs that can never successfully serve an Ethereum
            // JSON-RPC read, spuriously tightening the threshold every round.
            let primary_rpc_urls: Vec<Url> = Self::primary_rpc_urls(&origin_chain_conf);
            let additional_quorum_rpc_urls =
                Self::dedupe_additional_quorum_rpc_urls_against_primary(
                    &primary_rpc_urls,
                    additional_quorum_rpc_urls,
                );
            Self::warn_if_additional_quorum_rpc_not_public(&additional_quorum_rpc_urls);
            Self::warn_if_quorum_pool_undersized(
                primary_rpc_urls.len(),
                additional_quorum_rpc_urls.len(),
            );
            Self::warn_if_duplicate_hosts(&primary_rpc_urls, &additional_quorum_rpc_urls);
            Self::build_validator_quorum_merkle_tree_hook(
                &origin_chain_conf,
                &primary_rpc_urls,
                &additional_quorum_rpc_urls,
                &metrics,
            )
            .await?
        } else {
            if !additional_quorum_rpc_urls.is_empty() {
                warn!(
                    origin_chain = %settings.origin_chain,
                    "additionalQuorumRpcUrls is set but ignored: quorum verification is only supported for Ethereum chains"
                );
            }
            settings
                .build_merkle_tree_hook(&settings.origin_chain, &metrics)
                .await?
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
            merkle_tree_hook: merkle_tree_hook.into(),
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
        additional_quorum_rpc_urls: &[(Url, bool)],
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
    fn dedupe_additional_quorum_rpc_urls(urls: Vec<(Url, bool)>) -> Vec<(Url, bool)> {
        let original_count = urls.len();
        let mut seen = HashSet::new();
        let deduped: Vec<(Url, bool)> = urls
            .into_iter()
            .filter(|(url, _)| seen.insert(url.clone()))
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

    /// Removes any `additionalQuorumRpcUrls` entry whose URL is already in `rpcUrls`.
    /// Since both pools now vote together (see `ValidatorMultiRpcQuorumMerkleTreeHook`),
    /// keeping such a duplicate would cast two votes for what's really one provider,
    /// undermining the vote's independence assumption exactly like an in-pool duplicate
    /// would — `dedupe_additional_quorum_rpc_urls` only catches duplicates *within*
    /// `additionalQuorumRpcUrls`, not across the two pools.
    fn dedupe_additional_quorum_rpc_urls_against_primary(
        primary_rpc_urls: &[Url],
        additional_quorum_rpc_urls: Vec<(Url, bool)>,
    ) -> Vec<(Url, bool)> {
        let primary_set: HashSet<&Url> = primary_rpc_urls.iter().collect();
        let original_count = additional_quorum_rpc_urls.len();
        let deduped: Vec<(Url, bool)> = additional_quorum_rpc_urls
            .into_iter()
            .filter(|(url, _)| !primary_set.contains(url))
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
    /// legitimate choice) when multiple entries across `rpcUrls` and `additionalQuorumRpcUrls`
    /// combined share a host, grouped by label rather than the host itself so the log
    /// never reveals which provider it is. Both pools vote together (see
    /// `ValidatorMultiRpcQuorumMerkleTreeHook`), so a host shared between them casts 2
    /// votes for what's really one provider — the same independence concern as a
    /// duplicate within a single pool.
    fn warn_if_duplicate_hosts(
        primary_rpc_urls: &[Url],
        additional_quorum_rpc_urls: &[(Url, bool)],
    ) {
        let mut indices_by_host: HashMap<Option<&str>, Vec<String>> = HashMap::new();
        for (i, url) in primary_rpc_urls.iter().enumerate() {
            indices_by_host
                .entry(url.host_str())
                .or_default()
                .push(format!("rpcUrls[{i}]"));
        }
        for (i, (url, _)) in additional_quorum_rpc_urls.iter().enumerate() {
            indices_by_host
                .entry(url.host_str())
                .or_default()
                .push(format!("additionalQuorumRpcUrls[{i}]"));
        }
        let repeated_host_groups: Vec<Vec<String>> = indices_by_host
            .into_values()
            .filter(|labels| labels.len() > 1)
            .collect();
        if !repeated_host_groups.is_empty() {
            warn!(
                ?repeated_host_groups,
                "rpcUrls/additionalQuorumRpcUrls have multiple entries (by label) sharing a host; they \
                 likely share a failure domain, weakening the independence the vote relies on"
            );
        }
    }

    /// Warns if the combined `rpcUrls` + `additionalQuorumRpcUrls` pool is too small to provide
    /// meaningful protection.
    fn warn_if_quorum_pool_undersized(primary_count: usize, quorum_count: usize) {
        let total = primary_count.saturating_add(quorum_count);
        if total < MIN_RECOMMENDED_QUORUM_RPCS {
            warn!(
                primary_count,
                quorum_count,
                total,
                recommended_minimum = MIN_RECOMMENDED_QUORUM_RPCS,
                "the combined rpcUrls + additionalQuorumRpcUrls pool has very few entries and provides \
                 little to no real protection; consider adding more additionalQuorumRpcUrls entries"
            );
        }
    }

    /// Recommends `additionalQuorumRpcUrls` be used for *additional* public RPCs only: it now votes
    /// alongside `rpcUrls` (which already covers the private endpoints), so a private
    /// `additionalQuorumRpcUrls` entry just duplicates coverage `rpcUrls` already provides.
    fn warn_if_additional_quorum_rpc_not_public(additional_quorum_rpc_urls: &[(Url, bool)]) {
        let non_public_count = additional_quorum_rpc_urls
            .iter()
            .filter(|(_, public)| !public)
            .count();
        if non_public_count > 0 {
            warn!(
                non_public_count,
                "additionalQuorumRpcUrls contains non-public entries; it's intended for additional \
                 public RPCs only — private endpoints are already covered via rpcUrls"
            );
        }
    }

    async fn build_validator_quorum_merkle_tree_hook(
        origin_chain_conf: &ChainConf,
        primary_rpc_urls: &[Url],
        additional_quorum_rpc_urls: &[(Url, bool)],
        metrics: &CoreMetrics,
    ) -> ChainResult<Box<dyn MerkleTreeHook>> {
        let base_hook = origin_chain_conf.build_merkle_tree_hook(metrics).await?;
        let mut quorum_hooks = Self::build_validator_ethereum_per_url_hooks(
            origin_chain_conf,
            "rpcUrls",
            RpcRole::Primary,
            primary_rpc_urls,
            metrics,
        )
        .await?;
        let quorum_only_urls: Vec<Url> = additional_quorum_rpc_urls
            .iter()
            .map(|(url, _)| url.clone())
            .collect();
        quorum_hooks.extend(
            Self::build_validator_ethereum_per_url_hooks(
                origin_chain_conf,
                "additionalQuorumRpcUrls",
                RpcRole::Quorum,
                &quorum_only_urls,
                metrics,
            )
            .await?,
        );
        Ok(Box::new(ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: base_hook.into(),
            quorum_hooks,
        }) as Box<dyn MerkleTreeHook>)
    }

    /// The actual URLs `base_hook` (`rpcUrls`) is configured with, read directly from
    /// `origin_chain_conf.connection` rather than `settings.rpcs` (see the call site for
    /// why). Returns empty for a non-Ethereum connection; callers only reach this after
    /// `validator_uses_split_quorum_hook` has already confirmed it's Ethereum.
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

    fn ethereum_chain_conf_for_url(
        origin_chain_conf: &ChainConf,
        url: Url,
        role: RpcRole,
    ) -> ChainConf {
        let mut chain_conf = origin_chain_conf.clone();
        if let ChainConnectionConf::Ethereum(updated_conn) = &mut chain_conf.connection {
            updated_conn.rpc_connection = RpcConnectionConf::Http { url };
        }
        chain_conf.metrics_conf.rpc_role = role;
        chain_conf
    }

    /// Builds one single-URL `MerkleTreeHook` per entry in `urls`, labeled
    /// `{label_prefix}[i]` (by index, never by host/URL — some entries may be private
    /// RPCs, and even a redacted host can identify the provider, e.g. "alchemy.com", so
    /// disagreement logs must never carry anything derived from the URL itself) and
    /// tagged with `role` (both for `select_quorum_result`'s threshold logic and the
    /// underlying connection's `rpc_role` Prometheus label).
    async fn build_validator_ethereum_per_url_hooks(
        origin_chain_conf: &ChainConf,
        label_prefix: &str,
        role: RpcRole,
        urls: &[Url],
        metrics: &CoreMetrics,
    ) -> ChainResult<Vec<QuorumHook>> {
        let hooks = try_join_all(urls.iter().cloned().enumerate().map(|(i, url)| async move {
            Self::ethereum_chain_conf_for_url(origin_chain_conf, url, role)
                .build_merkle_tree_hook(metrics)
                .await
                .map(|hook| QuorumHook {
                    label: format!("{label_prefix}[{i}]"),
                    role,
                    hook: Arc::from(hook),
                })
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

        let quorum_urls = vec![(Url::parse("http://quorum-a.example").unwrap(), false)];
        assert!(Validator::validator_uses_split_quorum_hook(
            &chain_conf,
            &quorum_urls
        ));
    }

    #[test]
    fn dedupe_additional_quorum_rpc_urls_removes_exact_duplicates_preserving_order() {
        let urls = vec![
            (Url::parse("http://rpc-a.example").unwrap(), false),
            (Url::parse("http://rpc-b.example").unwrap(), true),
            (Url::parse("http://rpc-a.example").unwrap(), false),
            (Url::parse("http://rpc-c.example").unwrap(), true),
        ];

        let deduped = Validator::dedupe_additional_quorum_rpc_urls(urls);

        assert_eq!(
            deduped,
            vec![
                (Url::parse("http://rpc-a.example").unwrap(), false),
                (Url::parse("http://rpc-b.example").unwrap(), true),
                (Url::parse("http://rpc-c.example").unwrap(), true),
            ]
        );
    }

    #[test]
    fn dedupe_additional_quorum_rpc_urls_is_noop_without_duplicates() {
        let urls = vec![
            (Url::parse("http://rpc-a.example").unwrap(), false),
            (Url::parse("http://rpc-b.example").unwrap(), true),
        ];

        let deduped = Validator::dedupe_additional_quorum_rpc_urls(urls.clone());

        assert_eq!(deduped, urls);
    }

    #[test]
    #[tracing_test::traced_test]
    fn dedupe_additional_quorum_rpc_urls_against_primary_removes_shared_url() {
        let primary_urls = vec![Url::parse("http://rpc-a.example").unwrap()];
        let additional_urls = vec![
            (Url::parse("http://rpc-a.example").unwrap(), true),
            (Url::parse("http://rpc-b.example").unwrap(), true),
        ];

        let deduped = Validator::dedupe_additional_quorum_rpc_urls_against_primary(
            &primary_urls,
            additional_urls,
        );

        assert_eq!(
            deduped,
            vec![(Url::parse("http://rpc-b.example").unwrap(), true)]
        );
        assert!(logs_contain(
            "additionalQuorumRpcUrls contained entries already present in rpcUrls"
        ));
    }

    #[test]
    #[tracing_test::traced_test]
    fn dedupe_additional_quorum_rpc_urls_against_primary_is_noop_when_disjoint() {
        let primary_urls = vec![Url::parse("http://rpc-a.example").unwrap()];
        let additional_urls = vec![(Url::parse("http://rpc-b.example").unwrap(), true)];

        let deduped = Validator::dedupe_additional_quorum_rpc_urls_against_primary(
            &primary_urls,
            additional_urls.clone(),
        );

        assert_eq!(deduped, additional_urls);
        assert!(!logs_contain(
            "additionalQuorumRpcUrls contained entries already present in rpcUrls"
        ));
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
        Validator::warn_if_quorum_pool_undersized(1, 0);

        assert!(logs_contain(
            "combined rpcUrls + additionalQuorumRpcUrls pool has very few entries"
        ));
    }

    #[test]
    #[tracing_test::traced_test]
    fn warn_if_quorum_pool_undersized_silent_at_or_above_minimum() {
        Validator::warn_if_quorum_pool_undersized(1, 2);

        assert!(!logs_contain(
            "combined rpcUrls + additionalQuorumRpcUrls pool has very few entries"
        ));
    }

    #[test]
    #[tracing_test::traced_test]
    fn warn_if_additional_quorum_rpc_not_public_warns_on_private_entry() {
        let urls = vec![
            (Url::parse("http://public-a.example").unwrap(), true),
            (Url::parse("http://private-b.example").unwrap(), false),
        ];

        Validator::warn_if_additional_quorum_rpc_not_public(&urls);

        assert!(logs_contain(
            "additionalQuorumRpcUrls contains non-public entries"
        ));
    }

    #[test]
    #[tracing_test::traced_test]
    fn warn_if_additional_quorum_rpc_not_public_silent_when_all_public() {
        let urls = vec![
            (Url::parse("http://public-a.example").unwrap(), true),
            (Url::parse("http://public-b.example").unwrap(), true),
        ];

        Validator::warn_if_additional_quorum_rpc_not_public(&urls);

        assert!(!logs_contain(
            "additionalQuorumRpcUrls contains non-public entries"
        ));
    }

    #[test]
    #[tracing_test::traced_test]
    fn warn_if_duplicate_hosts_warns_on_shared_host() {
        let primary_urls = vec![Url::parse("http://shared.example/key-a").unwrap()];
        let quorum_urls = vec![
            (Url::parse("http://other.example").unwrap(), true),
            (Url::parse("http://shared.example/key-b").unwrap(), true),
        ];

        Validator::warn_if_duplicate_hosts(&primary_urls, &quorum_urls);

        assert!(logs_contain(
            "rpcUrls/additionalQuorumRpcUrls have multiple entries (by label) sharing a host"
        ));
    }

    #[test]
    #[tracing_test::traced_test]
    fn warn_if_duplicate_hosts_silent_when_all_distinct() {
        let primary_urls = vec![Url::parse("http://rpc-a.example").unwrap()];
        let quorum_urls = vec![(Url::parse("http://rpc-b.example").unwrap(), true)];

        Validator::warn_if_duplicate_hosts(&primary_urls, &quorum_urls);

        assert!(!logs_contain(
            "rpcUrls/additionalQuorumRpcUrls have multiple entries (by label) sharing a host"
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
        let labels: Vec<&str> = hooks.iter().map(|hook| hook.label.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "additionalQuorumRpcUrls[0]",
                "additionalQuorumRpcUrls[1]",
                "additionalQuorumRpcUrls[2]"
            ]
        );
        assert!(hooks.iter().all(|hook| hook.role == RpcRole::Quorum));
    }

    #[tokio::test]
    async fn build_validator_ethereum_per_url_hooks_empty_urls_produces_no_hooks() {
        let chain_conf = dummy_ethereum_chain_conf(vec![
            Url::parse("http://normal-a.example").unwrap(),
            Url::parse("http://normal-b.example").unwrap(),
        ]);
        let metrics = CoreMetrics::new(
            "validator-test-ethereum-quorum-hooks-empty",
            9092,
            Registry::new(),
        )
        .unwrap();

        let hooks = Validator::build_validator_ethereum_per_url_hooks(
            &chain_conf,
            "additionalQuorumRpcUrls",
            RpcRole::Quorum,
            &[],
            &metrics,
        )
        .await
        .unwrap();

        assert!(hooks.is_empty());
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

    /// An `additionalQuorumRpcUrls`-sourced entry (role `Quorum`): a failure is excluded from the
    /// round's threshold denominator.
    fn quorum_rpc(label: &str, hook: MockMerkleTreeHook) -> QuorumHook {
        quorum_rpc_with_role(label, RpcRole::Quorum, hook)
    }

    /// An `rpcUrls`-sourced entry (role `Primary`): a failure always still counts against
    /// the round's threshold denominator.
    fn primary_rpc(label: &str, hook: MockMerkleTreeHook) -> QuorumHook {
        quorum_rpc_with_role(label, RpcRole::Primary, hook)
    }

    fn quorum_rpc_with_role(label: &str, role: RpcRole, hook: MockMerkleTreeHook) -> QuorumHook {
        QuorumHook {
            label: label.to_string(),
            role,
            hook: Arc::new(hook) as Arc<dyn MerkleTreeHook>,
        }
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
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_reaches_two_thirds_majority() {
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

    /// If every quorum_hooks entry that failed is role `Quorum`, the round's returned
    /// error must not surface either entry's error text verbatim -- it should fall back
    /// to a generic message instead.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_all_quorum_role_failures_returns_generic_error(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
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
                Err(ChainCommunicationError::from_other_str(
                    "quorum-role-rpc-a-error-detail",
                ))
            });

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(5))
            .return_once(|_| {
                Err(ChainCommunicationError::from_other_str(
                    "quorum-role-rpc-b-error-detail",
                ))
            });

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![quorum_rpc("rpc-a", quorum_a), quorum_rpc("rpc-b", quorum_b)],
        };

        let err = hook.tree(&ReorgPeriod::None).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.contains("quorum-role-rpc-a-error-detail")
                && !msg.contains("quorum-role-rpc-b-error-detail"),
            "a Quorum-role RPC's error text must never surface: {msg}"
        );
    }

    /// When both a `Primary`-role and a `Quorum`-role quorum_hooks entry fail, the
    /// returned error must surface the `Primary`-role one's detail, never the
    /// `Quorum`-role one's.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_prefers_primary_role_error_over_quorum_role(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        base_hook.expect_tree_at_block().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 5);

        let mut quorum_role_rpc = MockMerkleTreeHook::new();
        quorum_role_rpc.expect_latest_checkpoint().never();
        quorum_role_rpc
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(5))
            .return_once(|_| {
                Err(ChainCommunicationError::from_other_str(
                    "quorum-role-rpc-error-detail",
                ))
            });

        let mut primary_role_rpc = MockMerkleTreeHook::new();
        primary_role_rpc.expect_latest_checkpoint().never();
        primary_role_rpc
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(5))
            .return_once(|_| {
                Err(ChainCommunicationError::from_other_str(
                    "primary-role-rpc-error-detail",
                ))
            });

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-quorum", quorum_role_rpc),
                primary_rpc("rpc-primary", primary_role_rpc),
            ],
        };

        let err = hook.tree(&ReorgPeriod::None).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("primary-role-rpc-error-detail"),
            "expected the Primary-role RPC's error to surface: {msg}"
        );
        assert!(
            !msg.contains("quorum-role-rpc-error-detail"),
            "a Quorum-role RPC's error text must never surface: {msg}"
        );
    }

    /// Regression test for a fail-open attack: if a compromised `Primary` manipulates the
    /// target height such that every honest `Quorum`-role RPC errors (e.g. "header not
    /// found" for a fabricated future height), the failed `Quorum`-role entries must
    /// still count against the (fixed) threshold -- otherwise the compromised `Primary`
    /// would trivially "win" a 1-of-1 vote against itself.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_rejects_when_quorum_role_pool_fully_fails(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        // Never reached: the merged vote fails before base_hook would be consulted.
        base_hook.expect_tree_at_block().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 42);

        let mut compromised_primary = MockMerkleTreeHook::new();
        compromised_primary.expect_latest_checkpoint().never();
        compromised_primary
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(|_| {
                let mut fabricated =
                    hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
                fabricated.ingest(H256::from_low_u64_be(1));
                Ok(IncrementalMerkleAtBlock {
                    tree: fabricated,
                    block_height: Some(42),
                })
            });

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_latest_checkpoint().never();
        quorum_a
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(|_| Err(ChainCommunicationError::from_other_str("header not found")));

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(|_| Err(ChainCommunicationError::from_other_str("header not found")));

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                primary_rpc("rpc-primary-compromised", compromised_primary),
                quorum_rpc("rpc-quorum-a", quorum_a),
                quorum_rpc("rpc-quorum-b", quorum_b),
            ],
        };

        assert!(
            hook.tree(&ReorgPeriod::None).await.is_err(),
            "a fully-failed Quorum-role pool must not let a lone Primary win by default"
        );
    }

    /// Regression test for a fail-open attack on *partial* Quorum-role pool failure: if a
    /// compromised `Primary` manipulates the target height such that only a colluding
    /// minority of `additionalQuorumRpcUrls` can answer (agreeing with the fabricated
    /// value) while the honest majority correctly errors "not found", the compromised
    /// `Primary` plus its single accomplice (2 of the fixed 4-entry denominator) must
    /// still fall short of the 2/3 threshold, so this round must fail to reach quorum.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_rejects_when_quorum_role_pool_minority_colludes(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        // Never reached: the merged vote fails to reach quorum before base_hook would be
        // consulted.
        base_hook.expect_tree_at_block().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 42);

        let fabricated_tree = {
            let mut fabricated =
                hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
            fabricated.ingest(H256::from_low_u64_be(1));
            IncrementalMerkleAtBlock {
                tree: fabricated,
                block_height: Some(42),
            }
        };

        let mut compromised_primary = MockMerkleTreeHook::new();
        compromised_primary.expect_latest_checkpoint().never();
        compromised_primary
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once({
                let fabricated_tree = fabricated_tree.clone();
                move |_| Ok(fabricated_tree)
            });

        let mut colluding_quorum = MockMerkleTreeHook::new();
        colluding_quorum.expect_latest_checkpoint().never();
        colluding_quorum
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(move |_| Ok(fabricated_tree));

        let mut honest_quorum_a = MockMerkleTreeHook::new();
        honest_quorum_a.expect_latest_checkpoint().never();
        honest_quorum_a
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(|_| Err(ChainCommunicationError::from_other_str("header not found")));

        let mut honest_quorum_b = MockMerkleTreeHook::new();
        honest_quorum_b.expect_latest_checkpoint().never();
        honest_quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(|_| Err(ChainCommunicationError::from_other_str("header not found")));

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                primary_rpc("rpc-primary-compromised", compromised_primary),
                quorum_rpc("rpc-quorum-colluding", colluding_quorum),
                quorum_rpc("rpc-quorum-honest-a", honest_quorum_a),
                quorum_rpc("rpc-quorum-honest-b", honest_quorum_b),
            ],
        };

        assert!(
            hook.tree(&ReorgPeriod::None).await.is_err(),
            "a colluding minority of the Quorum-role pool must not be able to shrink the \
             denominator enough to win alongside a compromised Primary"
        );
    }

    /// Regression test for a fail-open attack where the honest `Quorum`-role majority
    /// *responds* rather than errors, so a response-count-based exclusion signal (e.g.
    /// "2/3 of the Quorum-role pool responded this round") would have been satisfied even
    /// though only a minority actually agrees with the compromised `Primary`'s fabricated
    /// value: 1 compromised `Primary` + 1 colluding `Quorum`-role entry (agrees with the
    /// fabricated value) + 1 honest `Quorum`-role entry that answers with the correct,
    /// different value + 1 honest `Quorum`-role entry that errors. Neither the fabricated
    /// value (2 of the fixed 4-entry denominator) nor the honest value (1 of 4) reaches
    /// the 2/3 threshold, so this round must fail to reach quorum.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_rejects_when_quorum_role_pool_partially_disagrees(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        // Never reached: the merged vote fails to reach quorum before base_hook would be
        // consulted.
        base_hook.expect_tree_at_block().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 42);

        let fabricated_tree = {
            let mut fabricated =
                hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
            fabricated.ingest(H256::from_low_u64_be(1));
            IncrementalMerkleAtBlock {
                tree: fabricated,
                block_height: Some(42),
            }
        };
        let honest_tree = {
            let mut honest = hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
            honest.ingest(H256::from_low_u64_be(2));
            IncrementalMerkleAtBlock {
                tree: honest,
                block_height: Some(42),
            }
        };

        let mut compromised_primary = MockMerkleTreeHook::new();
        compromised_primary.expect_latest_checkpoint().never();
        compromised_primary
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once({
                let fabricated_tree = fabricated_tree.clone();
                move |_| Ok(fabricated_tree)
            });

        let mut colluding_quorum = MockMerkleTreeHook::new();
        colluding_quorum.expect_latest_checkpoint().never();
        colluding_quorum
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(move |_| Ok(fabricated_tree));

        let mut honest_quorum_correct = MockMerkleTreeHook::new();
        honest_quorum_correct.expect_latest_checkpoint().never();
        honest_quorum_correct
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(move |_| Ok(honest_tree));

        let mut honest_quorum_erroring = MockMerkleTreeHook::new();
        honest_quorum_erroring.expect_latest_checkpoint().never();
        honest_quorum_erroring
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(|_| Err(ChainCommunicationError::from_other_str("header not found")));

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                primary_rpc("rpc-primary-compromised", compromised_primary),
                quorum_rpc("rpc-quorum-colluding", colluding_quorum),
                quorum_rpc("rpc-quorum-honest-correct", honest_quorum_correct),
                quorum_rpc("rpc-quorum-honest-erroring", honest_quorum_erroring),
            ],
        };

        assert!(
            hook.tree(&ReorgPeriod::None).await.is_err(),
            "a compromised Primary plus a single colluding Quorum-role entry must not be \
             able to win just because a majority of the Quorum-role pool responded -- they \
             must also agree with the winning candidate"
        );
    }

    /// Regression test: 2 colluding/compromised `additionalQuorumRpcUrls` (`Quorum`-role,
    /// less-trusted public) entries can reach the overall 2/3 threshold on a wrong value
    /// even with an honest `Primary` disagreeing (1 Primary + 2 colluding Quorum = 2/3 on
    /// the colluding pair's value). `require_base_hook_agreement` must catch this:
    /// `base_hook` independently reflects the honest `rpcUrls` consensus, which disagrees
    /// with the colluding pair's value, so the round must be rejected.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_rejects_colluding_quorum_role_majority(
    ) {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();
        let honest_tree = IncrementalMerkleAtBlock {
            tree: Default::default(),
            block_height: Some(50),
        };
        let mut colluding_merkle =
            hyperlane_core::accumulator::incremental::IncrementalMerkle::default();
        colluding_merkle.ingest(H256::from_low_u64_be(1));
        let colluding_tree = IncrementalMerkleAtBlock {
            tree: colluding_merkle,
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
                let honest_tree = honest_tree.clone();
                move |_| Ok(honest_tree)
            });

        let mut honest_primary = MockMerkleTreeHook::new();
        honest_primary.expect_latest_checkpoint().never();
        honest_primary
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let honest_tree = honest_tree.clone();
                move |_| Ok(honest_tree)
            });

        let mut colluding_a = MockMerkleTreeHook::new();
        colluding_a.expect_latest_checkpoint().never();
        colluding_a
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let colluding_tree = colluding_tree.clone();
                move |_| Ok(colluding_tree)
            });

        let mut colluding_b = MockMerkleTreeHook::new();
        colluding_b.expect_latest_checkpoint().never();
        colluding_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| Ok(colluding_tree));

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                primary_rpc("rpc-primary-honest", honest_primary),
                quorum_rpc("rpc-quorum-colluding-a", colluding_a),
                quorum_rpc("rpc-quorum-colluding-b", colluding_b),
            ],
        };

        assert!(
            hook.tree(&ReorgPeriod::None).await.is_err(),
            "2 colluding Quorum-role entries must not be able to outvote an honest Primary"
        );
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

    /// 4 configured `quorum_hooks`, 1 `Quorum`-role RPC down this round. Unlike earlier
    /// revisions, a down `Quorum`-role entry is NOT excluded from the threshold's
    /// denominator (same treatment as a down `Primary`-role entry) -- see
    /// `select_quorum_result`'s doc comment for why. The threshold stays at
    /// ceil(2*4/3) = 3; only 2 of the 3 responders agree (the third disagrees), so
    /// quorum is not reached.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_does_not_exclude_down_quorum_role_rpc_from_threshold(
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
        // Never reached: the quorum_hooks vote fails before base_hook would be consulted.
        base_hook.expect_tree_at_block().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 50);

        let mut quorum_down = MockMerkleTreeHook::new();
        quorum_down.expect_latest_checkpoint().never();
        quorum_down
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(|_| Err(ChainCommunicationError::from_other_str("quorum rpc down")));

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let expected_tree = expected_tree.clone();
                move |_| Ok(expected_tree)
            });

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_latest_checkpoint().never();
        quorum_c
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| Ok(divergent_tree));

        let mut quorum_d = MockMerkleTreeHook::new();
        quorum_d.expect_latest_checkpoint().never();
        quorum_d
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| Ok(expected_tree));

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-quorum-down", quorum_down),
                quorum_rpc("rpc-b", quorum_b),
                quorum_rpc("rpc-c", quorum_c),
                quorum_rpc("rpc-d", quorum_d),
            ],
        };

        assert!(hook.tree(&ReorgPeriod::None).await.is_err());
    }

    /// Same 4-hook, 1-down, 1-disagreeing shape as the test above, except the down RPC is
    /// role `Primary` (an `rpcUrls` entry). `Primary`-role failures are NOT excluded from
    /// the threshold, so it stays at ceil(2*4/3) = 3; only 2 of the 3 responders agree ->
    /// quorum fails.
    #[tokio::test]
    #[tracing_test::traced_test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tree_does_not_exclude_down_primary_role_rpc_from_threshold(
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
        // Never reached: the quorum_hooks vote fails before base_hook would be consulted.
        base_hook.expect_tree_at_block().never();
        base_hook.expect_latest_checkpoint_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 50);

        let mut primary_down = MockMerkleTreeHook::new();
        primary_down.expect_latest_checkpoint().never();
        primary_down
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(|_| Err(ChainCommunicationError::from_other_str("primary rpc down")));

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once({
                let expected_tree = expected_tree.clone();
                move |_| Ok(expected_tree)
            });

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_latest_checkpoint().never();
        quorum_c
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| Ok(divergent_tree));

        let mut quorum_d = MockMerkleTreeHook::new();
        quorum_d.expect_latest_checkpoint().never();
        quorum_d
            .expect_tree_at_block()
            .once()
            .with(mockall::predicate::eq(50))
            .return_once(move |_| Ok(expected_tree));

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                primary_rpc("rpc-primary-down", primary_down),
                quorum_rpc("rpc-b", quorum_b),
                quorum_rpc("rpc-c", quorum_c),
                quorum_rpc("rpc-d", quorum_d),
            ],
        };

        assert!(hook.tree(&ReorgPeriod::None).await.is_err());
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

    fn dummy_checkpoint_at_block(
        mailbox_domain: u32,
        root: u64,
        index: u32,
        height: u64,
    ) -> CheckpointAtBlock {
        CheckpointAtBlock {
            checkpoint: hyperlane_core::Checkpoint {
                merkle_tree_hook_address: H256::from_low_u64_be(11),
                mailbox_domain,
                root: H256::from_low_u64_be(root),
                index,
            },
            block_height: Some(height),
        }
    }

    /// Also proves `latest_checkpoint()` correctly resolves a height (via `base_hook`) and
    /// delegates to `latest_checkpoint_at_block()`.
    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_uses_quorum_for_latest_checkpoint() {
        let mailbox_domain = dummy_domain(1337, "test-domain").id();
        let agreed_checkpoint = dummy_checkpoint_at_block(mailbox_domain, 22, 7, 99);
        let divergent_checkpoint = dummy_checkpoint_at_block(mailbox_domain, 23, 8, 99);

        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_tree().never();
        base_hook.expect_tree_at_block().never();
        mock_height_resolution(&mut base_hook, mailbox_domain, 99);
        base_hook
            .expect_latest_checkpoint_at_block()
            .once()
            .with(mockall::predicate::eq(99))
            .return_once({
                let agreed_checkpoint = agreed_checkpoint.clone();
                move |_| Ok(agreed_checkpoint)
            });

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_latest_checkpoint().never();
        quorum_a
            .expect_latest_checkpoint_at_block()
            .once()
            .with(mockall::predicate::eq(99))
            .return_once({
                let agreed_checkpoint = agreed_checkpoint.clone();
                move |_| Ok(agreed_checkpoint)
            });

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_latest_checkpoint().never();
        quorum_b
            .expect_latest_checkpoint_at_block()
            .once()
            .with(mockall::predicate::eq(99))
            .return_once(move |_| Ok(agreed_checkpoint));

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_latest_checkpoint().never();
        quorum_c
            .expect_latest_checkpoint_at_block()
            .once()
            .with(mockall::predicate::eq(99))
            .return_once(move |_| Ok(divergent_checkpoint));

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

    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_latest_checkpoint_at_block_uses_quorum() {
        let mut base_hook = MockMerkleTreeHook::new();
        base_hook.expect_count().never();
        base_hook.expect_latest_checkpoint().never();
        // `latest_checkpoint_at_block` takes an explicit height, so it never needs
        // height resolution -- but it still cross-checks the merged vote's winner
        // against base_hook's own independent result.
        base_hook
            .expect_latest_checkpoint_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(|height| {
                Ok(CheckpointAtBlock {
                    checkpoint: hyperlane_core::Checkpoint {
                        merkle_tree_hook_address: H256::from_low_u64_be(11),
                        mailbox_domain: 1337,
                        root: H256::from_low_u64_be(33),
                        index: 9,
                    },
                    block_height: Some(height),
                })
            });

        let make_hook = |root: u64, index: u64| {
            let mut hook = MockMerkleTreeHook::new();
            hook.expect_latest_checkpoint().never();
            hook.expect_latest_checkpoint_at_block()
                .once()
                .with(mockall::predicate::eq(42))
                .return_once(move |height| {
                    Ok(CheckpointAtBlock {
                        checkpoint: hyperlane_core::Checkpoint {
                            merkle_tree_hook_address: H256::from_low_u64_be(11),
                            mailbox_domain: 1337,
                            root: H256::from_low_u64_be(root),
                            index: index as u32,
                        },
                        block_height: Some(height),
                    })
                });
            hook
        };

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            base_hook: Arc::new(base_hook),
            quorum_hooks: vec![
                quorum_rpc("rpc-a", make_hook(33, 9)),
                quorum_rpc("rpc-b", make_hook(33, 9)),
                quorum_rpc("rpc-c", make_hook(44, 10)),
            ],
        };

        assert_eq!(
            hook.latest_checkpoint_at_block(42)
                .await
                .unwrap()
                .checkpoint
                .index,
            9
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
