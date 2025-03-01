use std::{sync::Arc, time::Duration};

use crate::server as validator_server;
use async_trait::async_trait;
use derive_more::AsRef;
use eyre::Result;

use futures_util::future::try_join_all;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{error, info, info_span, instrument::Instrumented, warn, Instrument};

use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB, DB},
    metrics::AgentMetrics,
    settings::ChainConf,
    AgentMetadata, BaseAgent, ChainMetrics, ChainSpecificMetricsUpdater, CheckpointSyncer,
    ContractSyncMetrics, ContractSyncer, CoreMetrics, HyperlaneAgentCore, RuntimeMetrics,
    SequencedDataContractSync,
};

use hyperlane_core::{
    Announcement, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneSigner,
    HyperlaneSignerExt, Mailbox, MerkleTreeHook, MerkleTreeInsertion, ReorgPeriod, TxOutcome,
    ValidatorAnnounce, H256, U256,
};
use hyperlane_ethereum::{SingletonSigner, SingletonSignerHandle};

use crate::{
    settings::{ChainValidatorSettings, ValidatorSettings},
    submit::{ValidatorSubmitter, ValidatorSubmitterMetrics},
};

/// A hyperlane validator which validates one more chain
#[derive(Debug, AsRef)]
pub struct Validator {
    validators: Vec<ChainValidator>,
    api_server_task: JoinHandle<()>,
}

// A validator bound to a single chain
#[derive(Debug, AsRef)]
pub struct ChainValidator {
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
    // temporary holder until `run` is called
    signer_instance: Option<Box<SingletonSigner>>,
    reorg_period: ReorgPeriod,
    interval: Duration,
    checkpoint_syncer: Arc<dyn CheckpointSyncer>,
    core_metrics: Arc<CoreMetrics>,
    agent_metrics: AgentMetrics,
    chain_metrics: ChainMetrics,
    runtime_metrics: RuntimeMetrics,
    agent_metadata: AgentMetadata,
}

#[async_trait]
impl BaseAgent for Validator {
    const AGENT_NAME: &'static str = "validator";

    type Settings = ValidatorSettings;

    async fn from_settings(
        agent_metadata: AgentMetadata,
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
        //  Create one set of sync metrics, otherwise process will crash with duplicate metrics registration errors
        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));

        // Create validators for each config
        let hyperlane_agent_core: HyperlaneAgentCore =
            settings.build_hyperlane_core(metrics.clone());
        let mut validators = vec![];
        for chain_validator_settings in &settings.validators {
            let validator = ChainValidator::make_validator(
                agent_metadata.clone(),
                chain_validator_settings.clone(),
                &settings.clone(),
                metrics.clone(),
                agent_metrics.clone(),
                chain_metrics.clone(),
                runtime_metrics.clone(),
                &contract_sync_metrics.clone(),
            )
            .await;

            validators.push(validator.unwrap());
        }

        // Create an api server
        let api_server_task = build_api_server(hyperlane_agent_core, metrics);

        Ok(Self {
            validators,
            api_server_task,
        })
    }

    async fn run(mut self) {
        let mut tasks: Vec<JoinHandle<()>> = vec![];

        // Start tasks for each validator
        for mut validator in self.validators {
            let chain_name = validator.origin_chain.name().to_string();

            // tasks.push(
            tasks.push(
                tokio::task::Builder::new()
                    .name(format!("{} validator", chain_name).as_str())
                    .spawn(
                        async move { validator.run().await }
                            .instrument(info_span!("Validator", chain = chain_name)),
                    )
                    .unwrap(),
            );
        }

        // And for the api server...
        tasks.push(self.api_server_task);

        // Note that this only returns an error if one of the tasks panics
        if let Err(err) = try_join_all(tasks).await {
            error!(?err, "One of the validator tasks returned an error");

            // Actively crash the entire process if a threaded validator fails, so that we don't silently drop a validator.
            std::process::exit(1)
        }
    }
}

fn build_api_server(
    hyperlane_agent_core: HyperlaneAgentCore,
    metrics: Arc<CoreMetrics>,
) -> JoinHandle<()> {
    // Set domain name to be custom "multiple-networks" in api server order to prevent confusion when looking at output.
    let api_server_domain = HyperlaneDomain::new_test_domain("multiple-networks");

    // Build an api server
    let custom_routes = validator_server::routes(api_server_domain, metrics.clone());
    let server = hyperlane_agent_core
        .settings
        .server(metrics.clone())
        .expect("Failed to create server");

    let server_task = tokio::task::Builder::new()
        .name("api server")
        .spawn(async move {
            server.run_with_custom_routes(custom_routes);
        })
        .unwrap();
    return server_task;
}

impl ChainValidator {
    async fn make_validator(
        agent_metadata: AgentMetadata,
        chain_validator_settings: ChainValidatorSettings,
        parent_settings: &ValidatorSettings,
        metrics: Arc<CoreMetrics>,
        agent_metrics: AgentMetrics,
        chain_metrics: ChainMetrics,
        runtime_metrics: RuntimeMetrics,
        contract_sync_metrics: &Arc<ContractSyncMetrics>,
    ) -> Result<Self>
    where
        Self: Sized,
    {
        let db = DB::from_path(&chain_validator_settings.db)?;
        let msg_db = HyperlaneRocksDB::new(&chain_validator_settings.origin_chain, db);

        // Intentionally using hyperlane_ethereum for the validator's signer
        let (signer_instance, signer) =
            SingletonSigner::new(chain_validator_settings.validator.build().await?);

        let core = parent_settings.build_hyperlane_core(metrics.clone());
        // Be extra sure to panic checkpoint syncer fails, which indicates
        // a fatal startup error.
        let checkpoint_syncer = chain_validator_settings
            .checkpoint_syncer
            .build_and_validate(None)
            .await
            .expect("Failed to build checkpoint syncer")
            .into();

        let mailbox = parent_settings
            .build_mailbox(&chain_validator_settings.origin_chain, &metrics)
            .await?;

        let merkle_tree_hook = parent_settings
            .build_merkle_tree_hook(&chain_validator_settings.origin_chain, &metrics)
            .await?;

        let validator_announce = parent_settings
            .build_validator_announce(&chain_validator_settings.origin_chain, &metrics)
            .await?;

        let origin_chain_conf = core
            .settings
            .chain_setup(&chain_validator_settings.origin_chain)
            .unwrap()
            .clone();

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));

        let merkle_tree_hook_sync = parent_settings
            .sequenced_contract_sync::<MerkleTreeInsertion, _>(
                &chain_validator_settings.origin_chain,
                &metrics,
                &contract_sync_metrics,
                msg_db.clone().into(),
                false,
            )
            .await?;

        Ok(Self {
            origin_chain: chain_validator_settings.origin_chain,
            origin_chain_conf,
            core,
            db: msg_db,
            mailbox: mailbox.into(),
            merkle_tree_hook: merkle_tree_hook.into(),
            merkle_tree_hook_sync,
            validator_announce: validator_announce.into(),
            signer,
            signer_instance: Some(Box::new(signer_instance)),
            reorg_period: chain_validator_settings.reorg_period,
            interval: chain_validator_settings.interval,
            checkpoint_syncer,
            agent_metrics,
            chain_metrics,
            core_metrics: metrics,
            runtime_metrics,
            agent_metadata,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(mut self) {
        let mut tasks = vec![];

        // run server
        let custom_routes =
            validator_server::routes(self.origin_chain.clone(), self.core.metrics.clone());
        let server = self
            .core
            .settings
            .server(self.core_metrics.clone())
            .expect("Failed to create server");
        let server_task = tokio::spawn(async move {
            server.run_with_custom_routes(custom_routes);
        })
        .instrument(info_span!("Validator server"));
        tasks.push(server_task);

        if let Some(signer_instance) = self.signer_instance.take() {
            tasks.push(
                tokio::spawn(async move {
                    signer_instance.run().await;
                })
                .instrument(info_span!("SingletonSigner")),
            );
        }

        let metrics_updater = ChainSpecificMetricsUpdater::new(
            &self.origin_chain_conf,
            self.core_metrics.clone(),
            self.agent_metrics.clone(),
            self.chain_metrics.clone(),
            "chain_validator".to_string(),
        )
        .await
        .unwrap();
        tasks.push(
            tokio::spawn(async move {
                metrics_updater.spawn().await.unwrap();
            })
            .instrument(info_span!("MetricsUpdater")),
        );

        // report agent metadata
        self.metadata()
            .await
            .expect("Failed to report agent metadata");

        // announce the validator after spawning the signer task
        self.announce().await.expect("Failed to announce validator");

        // Ensure that the merkle tree hook has count > 0 before we begin indexing
        // messages or submitting checkpoints.
        loop {
            match self.merkle_tree_hook.count(&self.reorg_period).await {
                Ok(0) => {
                    info!("Waiting for first message in merkle tree hook");
                    sleep(self.interval).await;
                }
                Ok(_) => {
                    tasks.push(self.run_merkle_tree_hook_sync().await);
                    for checkpoint_sync_task in self.run_checkpoint_submitters().await {
                        tasks.push(checkpoint_sync_task);
                    }
                    break;
                }
                _ => {
                    // Future that immediately resolves
                    return;
                }
            }
        }
        tasks.push(self.runtime_metrics.spawn());

        // Note that this only returns an error if one of the tasks panics
        if let Err(err) = try_join_all(tasks).await {
            error!(?err, "One of the validator tasks returned an error");
        }
    }

    async fn run_merkle_tree_hook_sync(&self) -> Instrumented<JoinHandle<()>> {
        let index_settings =
            self.as_ref().settings.chains[self.origin_chain.name()].index_settings();
        let contract_sync = self.merkle_tree_hook_sync.clone();
        let cursor = contract_sync
            .cursor(index_settings)
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "Error getting merkle tree hook cursor for origin {0}: {err}",
                    self.origin_chain
                )
            });
        let origin = self.origin_chain.name().to_string();
        tokio::spawn(async move {
            let label = "merkle_tree_hook";
            contract_sync.clone().sync(label, cursor.into()).await;
            info!(chain = origin, label, "contract sync task exit");
        })
        .instrument(info_span!("MerkleTreeHookSyncer"))
    }

    async fn run_checkpoint_submitters(&self) -> Vec<Instrumented<JoinHandle<()>>> {
        let submitter = ValidatorSubmitter::new(
            self.interval,
            self.reorg_period.clone(),
            self.merkle_tree_hook.clone(),
            self.signer.clone(),
            self.checkpoint_syncer.clone(),
            Arc::new(self.db.clone()) as Arc<dyn HyperlaneDb>,
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain),
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
        let backfill_target = submitter.checkpoint(&tip_tree);

        let backfill_submitter = submitter.clone();

        let mut tasks = vec![];
        tasks.push(
            tokio::spawn(async move {
                backfill_submitter
                    .backfill_checkpoint_submitter(backfill_target)
                    .await
            })
            .instrument(info_span!("BackfillCheckpointSubmitter")),
        );

        tasks.push(
            tokio::spawn(async move { submitter.checkpoint_submitter(tip_tree).await })
                .instrument(info_span!("TipCheckpointSubmitter")),
        );

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
        self.checkpoint_syncer
            .write_metadata(&self.agent_metadata)
            .await?;

        Ok(())
    }

    async fn announce(&self) -> Result<()> {
        let address = self.signer.eth_address();
        let announcement_location = self.checkpoint_syncer.announcement_location();

        // Sign and post the validator announcement
        let announcement = Announcement {
            validator: address,
            mailbox_address: self.mailbox.address(),
            mailbox_domain: self.mailbox.domain().id(),
            storage_location: announcement_location.clone(),
        };
        let signed_announcement = self.signer.sign(announcement.clone()).await?;
        self.checkpoint_syncer
            .write_announcement(&signed_announcement)
            .await?;

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
                    break;
                }
                info!(
                    announced_locations=?locations,
                    "Validator has not announced signature storage location"
                );

                if let Some(chain_signer) = self.core.settings.chains[self.origin_chain.name()]
                    .chain_signer()
                    .await?
                {
                    let chain_signer = chain_signer.address_string();
                    info!(eth_validator_address=?announcement.validator, ?chain_signer, "Attempting self announce");
                    let balance_delta = self
                        .validator_announce
                        .announce_tokens_needed(signed_announcement.clone())
                        .await
                        .unwrap_or_default();
                    if balance_delta > U256::zero() {
                        warn!(
                            tokens_needed=%balance_delta,
                            eth_validator_address=?announcement.validator,
                            ?chain_signer,
                            "Please send tokens to your chain signer address to announce",
                        );
                    } else {
                        let result = self
                            .validator_announce
                            .announce(signed_announcement.clone())
                            .await;
                        Self::log_on_announce_failure(result, &chain_signer);
                    }
                } else {
                    warn!(origin_chain=%self.origin_chain, "Cannot announce validator without a signer; make sure a signer is set for the origin chain");
                }

                sleep(self.interval).await;
            }
        }
        Ok(())
    }
}
