use std::{fmt::Debug, sync::Arc, time::Duration};

use async_trait::async_trait;
use axum::Router;
use derive_more::AsRef;
use ethers::utils::keccak256;
use eyre::{eyre, Result};
use futures_util::future::{join_all, try_join_all};
use serde::Serialize;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{error, info, info_span, warn, Instrument};
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
    rpc_clients::RPC_RETRY_SLEEP_DURATION, Announcement, ChainCommunicationError, ChainResult,
    CheckpointAtBlock, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneSigner,
    HyperlaneSignerExt, IncrementalMerkleAtBlock, Mailbox, MerkleTreeHook, MerkleTreeInsertion,
    ReorgPeriod, TxOutcome, ValidatorAnnounce, H256, U256,
};
use hyperlane_ethereum::{RpcConnectionConf, Signers, SingletonSigner, SingletonSignerHandle};

use crate::reorg_reporter::{
    LatestCheckpointReorgReporter, LatestCheckpointReorgReporterWithStorageWriter, ReorgReporter,
};
use crate::server::{self as validator_server, merkle_tree_insertions};
use crate::{
    settings::ValidatorSettings,
    submit::{ValidatorSubmitter, ValidatorSubmitterMetrics},
};

const CURSOR_INSTANTIATION_ATTEMPTS: usize = 10;

/// Wraps a plain (unmodified-config) hook for `count()`/domain/address, and a set of
/// independently-built, single-provider hooks for the safety-critical reads (`tree()`,
/// `latest_checkpoint()`, `latest_checkpoint_at_block()`), which are only accepted once
/// a majority of them agree byte-for-byte. Used for both Ethereum and Tron.
#[derive(Debug)]
struct ValidatorMultiRpcQuorumMerkleTreeHook {
    fallback: Arc<dyn MerkleTreeHook>,
    quorum_hooks: Vec<Arc<dyn MerkleTreeHook>>,
}

impl ValidatorMultiRpcQuorumMerkleTreeHook {
    fn quorum_threshold(&self) -> usize {
        (self.quorum_hooks.len() / 2).saturating_add(1)
    }

    fn select_quorum_result<T: Clone + Debug>(
        &self,
        results: Vec<ChainResult<T>>,
        matches: impl Fn(&T, &T) -> bool,
        context: &str,
    ) -> ChainResult<T> {
        let mut oks = Vec::new();
        let mut first_err = None;

        for result in results {
            match result {
                Ok(value) => oks.push(value),
                Err(err) => {
                    if first_err.is_none() {
                        first_err = Some(err);
                    }
                }
            }
        }

        let mut max_agreeing = 0;
        for candidate in &oks {
            let agreeing = oks.iter().filter(|other| matches(candidate, other)).count();
            max_agreeing = max_agreeing.max(agreeing);
            if agreeing >= self.quorum_threshold() {
                if agreeing < oks.len() {
                    // Majority was reached, but not everyone agreed. Not fatal, but
                    // worth surfacing: this is what a compromised/lagging minority
                    // provider being outvoted looks like.
                    warn!(
                        context,
                        accepted = ?candidate,
                        agreeing_count = agreeing,
                        total_successful = oks.len(),
                        all_values = ?oks,
                        "Quorum reached despite provider disagreement"
                    );
                }
                return Ok(candidate.clone());
            }
        }

        if oks.is_empty() {
            return Err(
                first_err.unwrap_or_else(|| ChainCommunicationError::from_other_str(context))
            );
        }

        let threshold = self.quorum_threshold();
        // Distinguish "not enough of the pool responded successfully" (the successful
        // ones may well agree with each other) from "enough responded, but they
        // genuinely gave conflicting answers" -- these call for different responses
        // from an operator, and the old message conflated them (e.g. claiming "1
        // successful hooks disagreed", which isn't a meaningful disagreement at all).
        if max_agreeing == oks.len() {
            warn!(
                context,
                total_successful = oks.len(),
                threshold,
                all_values = ?oks,
                "Failed to reach quorum: not enough successful responses"
            );
            Err(ChainCommunicationError::from_other_str(&format!(
                "{context}; only {ok_count} of {threshold} required responses succeeded",
                ok_count = oks.len()
            )))
        } else {
            warn!(
                context,
                total_successful = oks.len(),
                max_agreeing,
                threshold,
                all_values = ?oks,
                "Failed to reach quorum: successful responses disagreed"
            );
            Err(ChainCommunicationError::from_other_str(&format!(
                "{context}; {ok_count} successful responses disagreed (largest agreeing group: {max_agreeing}, needed {threshold})",
                ok_count = oks.len()
            )))
        }
    }
}

#[async_trait]
impl MerkleTreeHook for ValidatorMultiRpcQuorumMerkleTreeHook {
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        let results = join_all(self.quorum_hooks.iter().cloned().map(|hook| {
            let reorg_period = reorg_period.clone();
            async move { hook.tree(&reorg_period).await }
        }))
        .await;

        self.select_quorum_result(
            results,
            |a, b| a.tree == b.tree && a.block_height == b.block_height,
            "Failed to reach quorum for merkle tree",
        )
    }

    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        self.fallback.count(reorg_period).await
    }

    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        let results = join_all(self.quorum_hooks.iter().cloned().map(|hook| {
            let reorg_period = reorg_period.clone();
            async move { hook.latest_checkpoint(&reorg_period).await }
        }))
        .await;

        self.select_quorum_result(
            results,
            |a, b| a.checkpoint == b.checkpoint && a.block_height == b.block_height,
            "Failed to reach quorum for latest_checkpoint",
        )
    }

    async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock> {
        let results = join_all(
            self.quorum_hooks
                .iter()
                .cloned()
                .map(|hook| async move { hook.latest_checkpoint_at_block(height).await }),
        )
        .await;

        self.select_quorum_result(
            results,
            |a, b| a.checkpoint == b.checkpoint && a.block_height == b.block_height,
            "Failed to reach quorum for latest_checkpoint_at_block",
        )
    }
}

impl HyperlaneChain for ValidatorMultiRpcQuorumMerkleTreeHook {
    fn domain(&self) -> &HyperlaneDomain {
        self.fallback.domain()
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        self.fallback.provider()
    }
}

impl HyperlaneContract for ValidatorMultiRpcQuorumMerkleTreeHook {
    fn address(&self) -> H256 {
        self.fallback.address()
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
    allows_public_rpcs: bool,
}
#[derive(Debug, Serialize)]
pub struct ValidatorMetadataRpcEntry {
    url_hash: H256,
    host_hash: H256,
}

impl MetadataFromSettings<ValidatorSettings> for ValidatorMetadata {
    /// Create a new instance of the agent metadata from the settings
    fn build_metadata(settings: &ValidatorSettings) -> ValidatorMetadata {
        // Hash all the RPCs for the metadata
        let rpcs = settings
            .rpcs
            .iter()
            .map(|rpc| ValidatorMetadataRpcEntry {
                url_hash: H256::from_slice(&keccak256(&rpc.url)),
                host_hash: H256::from_slice(&keccak256(
                    Url::parse(&rpc.url)
                        .ok()
                        .and_then(|url| url.host_str().map(str::to_string))
                        .unwrap_or("".to_string()),
                )),
            })
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
        // Check for public rpcs in the config. Only `rpcs` (indexing/fallback)
        // is gated here — `quorum_rpcs` is designed to use public RPCs safely
        // via majority agreement, so a public entry there isn't a risk to flag.
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
        let quorum_rpc_urls: Vec<Url> = settings
            .quorum_rpcs
            .iter()
            .map(|rpc| {
                Url::parse(&rpc.url)
                    .map_err(|err| eyre!("Invalid quorumRpcUrls entry `{}`: {err}", rpc.url))
            })
            .collect::<Result<_>>()?;

        let mailbox = origin_chain_conf.build_mailbox(&metrics).await?;

        // Note: indexing and `count()` always use the chain's normally-configured
        // RPC connection (whatever `rpcConsensusType` the operator already chose --
        // fallback, quorum, or single). Only the safety-critical reads below get a
        // dedicated, independently-verified quorum path; nothing here overrides how
        // the chain is otherwise configured.
        let merkle_tree_hook = if Self::validator_uses_split_quorum_hook(&origin_chain_conf) {
            Self::build_validator_quorum_merkle_tree_hook(
                &origin_chain_conf,
                &quorum_rpc_urls,
                &metrics,
            )
            .await?
        } else {
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

        // Ensure that the merkle tree hook has at least one message on the safety path
        // messages or submitting checkpoints.
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
    fn validator_uses_split_quorum_hook(origin_chain_conf: &ChainConf) -> bool {
        matches!(
            origin_chain_conf.connection,
            ChainConnectionConf::Ethereum(_) | ChainConnectionConf::Tron(_)
        )
    }

    /// Builds the validator's merkle tree hook. `count()`/domain/address are served by a
    /// plain hook built from the chain's normal, already-configured connection (whatever
    /// `rpcConsensusType` the operator chose is left untouched). The safety-critical reads
    /// (`tree()`, `latest_checkpoint()`, `latest_checkpoint_at_block()`) are served by a set
    /// of independent, single-provider hooks that must reach majority agreement.
    async fn build_validator_quorum_merkle_tree_hook(
        origin_chain_conf: &ChainConf,
        quorum_rpc_urls: &[Url],
        metrics: &CoreMetrics,
    ) -> ChainResult<Box<dyn MerkleTreeHook>> {
        let fallback_hook = origin_chain_conf.build_merkle_tree_hook(metrics).await?;
        let quorum_hooks = match &origin_chain_conf.connection {
            ChainConnectionConf::Ethereum(_) => {
                Self::build_validator_ethereum_quorum_hooks(
                    origin_chain_conf,
                    quorum_rpc_urls,
                    metrics,
                )
                .await?
            }
            ChainConnectionConf::Tron(_) => {
                Self::build_validator_tron_quorum_hooks(origin_chain_conf, metrics).await?
            }
            _ => unreachable!("validator split quorum hook only supports ethereum and tron"),
        };
        Ok(Box::new(ValidatorMultiRpcQuorumMerkleTreeHook {
            fallback: fallback_hook.into(),
            quorum_hooks,
        }) as Box<dyn MerkleTreeHook>)
    }

    async fn build_validator_ethereum_quorum_hooks(
        origin_chain_conf: &ChainConf,
        quorum_rpc_urls: &[Url],
        metrics: &CoreMetrics,
    ) -> ChainResult<Vec<Arc<dyn MerkleTreeHook>>> {
        let ChainConnectionConf::Ethereum(conn) = &origin_chain_conf.connection else {
            unreachable!("ethereum quorum hooks only supported for ethereum chains");
        };

        // Prefer a dedicated quorum RPC set (e.g. a broader public pool) when configured;
        // otherwise fall back to reusing the chain's normal RPCs.
        let urls: Vec<Url> = if quorum_rpc_urls.is_empty() {
            conn.rpc_urls()
        } else {
            quorum_rpc_urls.to_vec()
        };

        if urls.is_empty() {
            return Err(ChainCommunicationError::from_other_str(
                "Ethereum validator safety hooks require at least one RPC URL",
            ));
        }

        let mut quorum_hooks = Vec::new();

        for url in urls {
            let mut chain_conf = origin_chain_conf.clone();
            if let ChainConnectionConf::Ethereum(updated_conn) = &mut chain_conf.connection {
                updated_conn.rpc_connection = RpcConnectionConf::Http { url };
            }
            quorum_hooks.push(chain_conf.build_merkle_tree_hook(metrics).await?.into());
        }

        Ok(quorum_hooks)
    }

    async fn build_validator_tron_quorum_hooks(
        origin_chain_conf: &ChainConf,
        metrics: &CoreMetrics,
    ) -> ChainResult<Vec<Arc<dyn MerkleTreeHook>>> {
        let ChainConnectionConf::Tron(conn) = &origin_chain_conf.connection else {
            unreachable!("tron quorum hooks only supported for tron chains");
        };

        if conn.wallet_solidity_urls.is_empty() {
            return Err(ChainCommunicationError::from_other_str(
                "Tron validator safety hooks require wallet_solidity_urls",
            ));
        }

        let mut quorum_hooks = Vec::new();

        for wallet_solidity_url in conn.wallet_solidity_urls.clone() {
            let mut chain_conf = origin_chain_conf.clone();
            if let ChainConnectionConf::Tron(updated_conn) = &mut chain_conf.connection {
                updated_conn.wallet_solidity_urls = vec![wallet_solidity_url];
            }
            quorum_hooks.push(chain_conf.build_merkle_tree_hook(metrics).await?.into());
        }

        Ok(quorum_hooks)
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

        let tip_tree = self
            .merkle_tree_hook
            .tree(&self.reorg_period)
            .await
            .expect("failed to get merkle tree");

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

    use super::*;

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

    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_uses_quorum_for_quorum_reads() {
        let domain = dummy_domain(1337, "test-domain");
        let expected_tree = IncrementalMerkleAtBlock {
            tree: Default::default(),
            block_height: Some(11),
        };
        let divergent_tree = IncrementalMerkleAtBlock {
            tree: Default::default(),
            block_height: Some(12),
        };
        let expected_checkpoint = CheckpointAtBlock {
            checkpoint: hyperlane_core::Checkpoint {
                merkle_tree_hook_address: H256::from_low_u64_be(11),
                mailbox_domain: domain.id(),
                root: H256::from_low_u64_be(22),
                index: 7,
            },
            block_height: Some(99),
        };
        let divergent_checkpoint = CheckpointAtBlock {
            checkpoint: hyperlane_core::Checkpoint {
                merkle_tree_hook_address: H256::from_low_u64_be(11),
                mailbox_domain: domain.id(),
                root: H256::from_low_u64_be(23),
                index: 8,
            },
            block_height: Some(100),
        };

        let mut fallback = MockMerkleTreeHook::new();
        fallback.expect_domain().return_const(domain.clone());
        fallback
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        fallback.expect_provider().never();
        fallback.expect_count().once().return_once(|_| Ok(3));
        fallback.expect_tree().never();
        fallback.expect_latest_checkpoint().never();
        fallback.expect_latest_checkpoint_at_block().never();

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_domain().return_const(domain.clone());
        quorum_a
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        quorum_a.expect_provider().never();
        quorum_a.expect_count().never();
        quorum_a.expect_tree().once().return_once({
            let expected_tree = expected_tree.clone();
            move |_| Ok(expected_tree)
        });
        quorum_a.expect_latest_checkpoint().once().return_once({
            let expected_checkpoint = expected_checkpoint.clone();
            move |_| Ok(expected_checkpoint)
        });
        quorum_a
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

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_domain().return_const(domain.clone());
        quorum_b
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        quorum_b.expect_provider().never();
        quorum_b.expect_count().never();
        quorum_b.expect_tree().once().return_once({
            let expected_tree = expected_tree.clone();
            move |_| Ok(expected_tree)
        });
        quorum_b.expect_latest_checkpoint().once().return_once({
            let expected_checkpoint = expected_checkpoint.clone();
            move |_| Ok(expected_checkpoint)
        });
        quorum_b
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

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_domain().return_const(domain.clone());
        quorum_c
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        quorum_c.expect_provider().never();
        quorum_c.expect_count().never();
        quorum_c
            .expect_tree()
            .once()
            .return_once(|_| Ok(divergent_tree));
        quorum_c
            .expect_latest_checkpoint()
            .once()
            .return_once(|_| Ok(divergent_checkpoint));
        quorum_c
            .expect_latest_checkpoint_at_block()
            .once()
            .with(mockall::predicate::eq(42))
            .return_once(|height| {
                Ok(CheckpointAtBlock {
                    checkpoint: hyperlane_core::Checkpoint {
                        merkle_tree_hook_address: H256::from_low_u64_be(11),
                        mailbox_domain: 1337,
                        root: H256::from_low_u64_be(44),
                        index: 10,
                    },
                    block_height: Some(height),
                })
            });

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            fallback: Arc::new(fallback),
            quorum_hooks: vec![Arc::new(quorum_a), Arc::new(quorum_b), Arc::new(quorum_c)],
        };

        assert_eq!(hook.count(&ReorgPeriod::None).await.unwrap(), 3);
        assert_eq!(
            hook.tree(&ReorgPeriod::None).await.unwrap().block_height,
            Some(11)
        );
        assert_eq!(
            hook.latest_checkpoint(&ReorgPeriod::None)
                .await
                .unwrap()
                .checkpoint
                .index,
            7
        );
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
    async fn validator_multi_rpc_quorum_merkle_tree_hook_errors_without_quorum() {
        let domain = dummy_domain(1337, "test-domain");

        let mut fallback = MockMerkleTreeHook::new();
        fallback.expect_domain().return_const(domain.clone());
        fallback
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        fallback.expect_provider().never();
        fallback.expect_count().never();
        fallback.expect_tree().never();
        fallback.expect_latest_checkpoint().never();
        fallback.expect_latest_checkpoint_at_block().never();

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_domain().return_const(domain.clone());
        quorum_a
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        quorum_a.expect_provider().never();
        quorum_a.expect_count().never();
        quorum_a.expect_tree().once().return_once(|_| {
            Ok(IncrementalMerkleAtBlock {
                tree: Default::default(),
                block_height: Some(1),
            })
        });
        quorum_a.expect_latest_checkpoint().never();
        quorum_a.expect_latest_checkpoint_at_block().never();

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_domain().return_const(domain.clone());
        quorum_b
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        quorum_b.expect_provider().never();
        quorum_b.expect_count().never();
        quorum_b.expect_tree().once().return_once(|_| {
            Ok(IncrementalMerkleAtBlock {
                tree: Default::default(),
                block_height: Some(2),
            })
        });
        quorum_b.expect_latest_checkpoint().never();
        quorum_b.expect_latest_checkpoint_at_block().never();

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_domain().return_const(domain);
        quorum_c
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        quorum_c.expect_provider().never();
        quorum_c.expect_count().never();
        quorum_c.expect_tree().once().return_once(|_| {
            Ok(IncrementalMerkleAtBlock {
                tree: Default::default(),
                block_height: Some(3),
            })
        });
        quorum_c.expect_latest_checkpoint().never();
        quorum_c.expect_latest_checkpoint_at_block().never();

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            fallback: Arc::new(fallback),
            quorum_hooks: vec![Arc::new(quorum_a), Arc::new(quorum_b), Arc::new(quorum_c)],
        };

        assert!(hook.tree(&ReorgPeriod::None).await.is_err());
    }

    #[tokio::test]
    async fn validator_multi_rpc_quorum_merkle_tree_hook_tolerates_partial_failures() {
        let domain = dummy_domain(1337, "test-domain");
        let expected_tree = IncrementalMerkleAtBlock {
            tree: Default::default(),
            block_height: Some(11),
        };

        let mut fallback = MockMerkleTreeHook::new();
        fallback.expect_domain().return_const(domain.clone());
        fallback
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        fallback.expect_provider().never();
        fallback.expect_count().never();
        fallback.expect_tree().never();
        fallback.expect_latest_checkpoint().never();
        fallback.expect_latest_checkpoint_at_block().never();

        let mut quorum_a = MockMerkleTreeHook::new();
        quorum_a.expect_domain().return_const(domain.clone());
        quorum_a
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        quorum_a.expect_provider().never();
        quorum_a.expect_count().never();
        quorum_a.expect_tree().once().return_once({
            let expected_tree = expected_tree.clone();
            move |_| Ok(expected_tree)
        });
        quorum_a.expect_latest_checkpoint().never();
        quorum_a.expect_latest_checkpoint_at_block().never();

        let mut quorum_b = MockMerkleTreeHook::new();
        quorum_b.expect_domain().return_const(domain.clone());
        quorum_b
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        quorum_b.expect_provider().never();
        quorum_b.expect_count().never();
        quorum_b
            .expect_tree()
            .once()
            .return_once(|_| Err(ChainCommunicationError::from_other_str("boom").into()));
        quorum_b.expect_latest_checkpoint().never();
        quorum_b.expect_latest_checkpoint_at_block().never();

        let mut quorum_c = MockMerkleTreeHook::new();
        quorum_c.expect_domain().return_const(domain);
        quorum_c
            .expect_address()
            .return_const(H256::from_low_u64_be(11));
        quorum_c.expect_provider().never();
        quorum_c.expect_count().never();
        quorum_c
            .expect_tree()
            .once()
            .return_once(move |_| Ok(expected_tree));
        quorum_c.expect_latest_checkpoint().never();
        quorum_c.expect_latest_checkpoint_at_block().never();

        let hook = ValidatorMultiRpcQuorumMerkleTreeHook {
            fallback: Arc::new(fallback),
            quorum_hooks: vec![Arc::new(quorum_a), Arc::new(quorum_b), Arc::new(quorum_c)],
        };

        assert_eq!(
            hook.tree(&ReorgPeriod::None).await.unwrap().block_height,
            Some(11)
        );
    }
}
