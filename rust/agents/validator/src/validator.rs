use std::{num::NonZeroU64, sync::Arc, time::Duration};

use async_trait::async_trait;
use derive_more::AsRef;
use eyre::Result;
use futures_util::future::ready;
use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    run_all, BaseAgent, CheckpointSyncer, ContractSyncMetrics, CoreMetrics, HyperlaneAgentCore,
    WatermarkContractSync,
};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Announcement, ChainResult, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneSigner, HyperlaneSignerExt, Mailbox,
    MerkleTreeHook, MerkleTreeInsertion, TxOutcome, ValidatorAnnounce, H256, U256,
};
use hyperlane_ethereum::{SingletonSigner, SingletonSignerHandle};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{error, info, info_span, instrument::Instrumented, warn, Instrument};

use crate::{
    settings::ValidatorSettings,
    submit::{ValidatorSubmitter, ValidatorSubmitterMetrics},
};

/// A validator agent
#[derive(Debug, AsRef)]
pub struct Validator {
    origin_chain: HyperlaneDomain,
    #[as_ref]
    core: HyperlaneAgentCore,
    db: HyperlaneRocksDB,
    merkle_tree_hook_sync: Arc<WatermarkContractSync<MerkleTreeInsertion>>,
    mailbox: Arc<dyn Mailbox>,
    merkle_tree_hook: Arc<dyn MerkleTreeHook>,
    validator_announce: Arc<dyn ValidatorAnnounce>,
    signer: SingletonSignerHandle,
    // temporary holder until `run` is called
    signer_instance: Option<Box<SingletonSigner>>,
    reorg_period: u64,
    interval: Duration,
    checkpoint_syncer: Arc<dyn CheckpointSyncer>,
}

#[async_trait]
impl BaseAgent for Validator {
    const AGENT_NAME: &'static str = "validator";

    type Settings = ValidatorSettings;

    async fn from_settings(settings: Self::Settings, metrics: Arc<CoreMetrics>) -> Result<Self>
    where
        Self: Sized,
    {
        let db = DB::from_path(&settings.db)?;
        let msg_db = HyperlaneRocksDB::new(&settings.origin_chain, db);

        // Intentionally using hyperlane_ethereum for the validator's signer
        let (signer_instance, signer) = SingletonSigner::new(settings.validator.build().await?);

        let core = settings.build_hyperlane_core(metrics.clone());
        let checkpoint_syncer = settings.checkpoint_syncer.build(None)?.into();

        let mailbox = settings
            .build_mailbox(&settings.origin_chain, &metrics)
            .await?;

        let merkle_tree_hook = settings
            .build_merkle_tree_hook(&settings.origin_chain, &metrics)
            .await?;

        let validator_announce = settings
            .build_validator_announce(&settings.origin_chain, &metrics)
            .await?;

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));

        let merkle_tree_hook_sync = settings
            .build_merkle_tree_hook_indexer(
                &settings.origin_chain,
                &metrics,
                &contract_sync_metrics,
                Arc::new(msg_db.clone()),
            )
            .await?
            .into();

        Ok(Self {
            origin_chain: settings.origin_chain,
            core,
            db: msg_db,
            mailbox: mailbox.into(),
            merkle_tree_hook: merkle_tree_hook.into(),
            merkle_tree_hook_sync,
            validator_announce: validator_announce.into(),
            signer,
            signer_instance: Some(Box::new(signer_instance)),
            reorg_period: settings.reorg_period,
            interval: settings.interval,
            checkpoint_syncer,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        let mut tasks = vec![];

        if let Some(signer_instance) = self.signer_instance.take() {
            tasks.push(
                tokio::spawn(async move {
                    signer_instance.run().await;
                    Ok(())
                })
                .instrument(info_span!("SingletonSigner")),
            );
        }

        // announce the validator after spawning the signer task
        self.announce().await.expect("Failed to announce validator");

        let reorg_period = NonZeroU64::new(self.reorg_period);

        // Ensure that the merkle tree hook has count > 0 before we begin indexing
        // messages or submitting checkpoints.
        loop {
            match self.merkle_tree_hook.count(reorg_period).await {
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
                    return tokio::spawn(ready(Ok(()))).instrument(info_span!("Validator"));
                }
            }
        }

        run_all(tasks)
    }
}

impl Validator {
    async fn run_merkle_tree_hook_sync(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let index_settings =
            self.as_ref().settings.chains[self.origin_chain.name()].index_settings();
        let contract_sync = self.merkle_tree_hook_sync.clone();
        let cursor = contract_sync.rate_limited_cursor(index_settings).await;
        tokio::spawn(async move { contract_sync.clone().sync("merkle_tree_hook", cursor).await })
            .instrument(info_span!("MerkleTreeHookSyncer"))
    }

    async fn run_checkpoint_submitters(&self) -> Vec<Instrumented<JoinHandle<Result<()>>>> {
        let submitter = ValidatorSubmitter::new(
            self.interval,
            self.reorg_period,
            self.merkle_tree_hook.clone(),
            self.signer.clone(),
            self.checkpoint_syncer.clone(),
            self.db.clone(),
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain),
        );

        let empty_tree = IncrementalMerkle::default();
        let reorg_period = NonZeroU64::new(self.reorg_period);
        let tip_tree = self
            .merkle_tree_hook
            .tree(reorg_period)
            .await
            .expect("failed to get merkle tree");
        assert!(tip_tree.count() > 0, "merkle tree is empty");
        let backfill_target = submitter.checkpoint(&tip_tree);

        let legacy_submitter = submitter.clone();
        let backfill_submitter = submitter.clone();

        let mut tasks = vec![];
        tasks.push(
            tokio::spawn(async move {
                backfill_submitter
                    .checkpoint_submitter(empty_tree, Some(backfill_target))
                    .await
            })
            .instrument(info_span!("BackfillCheckpointSubmitter")),
        );

        tasks.push(
            tokio::spawn(async move { submitter.checkpoint_submitter(tip_tree, None).await })
                .instrument(info_span!("TipCheckpointSubmitter")),
        );
        tasks.push(
            tokio::spawn(async move { legacy_submitter.legacy_checkpoint_submitter().await })
                .instrument(info_span!("LegacyCheckpointSubmitter")),
        );

        tasks
    }

    fn log_on_announce_failure(result: ChainResult<TxOutcome>) {
        match result {
            Ok(outcome) => {
                if !outcome.executed {
                    error!(
                        txid=?outcome.transaction_id,
                        gas_used=?outcome.gas_used,
                        gas_price=?outcome.gas_price,
                        "Transaction attempting to announce validator reverted. Make sure you have enough funds in your account to pay for transaction fees."
                    );
                }
            }
            Err(err) => {
                error!(
                    ?err,
                    "Failed to announce validator. Make sure you have enough ETH in your account to pay for gas."
                );
            }
        }
    }

    async fn announce(&self) -> Result<()> {
        // Sign and post the validator announcement
        let announcement = Announcement {
            validator: self.signer.eth_address(),
            mailbox_address: self.mailbox.address(),
            mailbox_domain: self.mailbox.domain().id(),
            storage_location: self.checkpoint_syncer.announcement_location(),
        };
        let signed_announcement = self.signer.sign(announcement.clone()).await?;
        self.checkpoint_syncer
            .write_announcement(&signed_announcement)
            .await?;

        // Ensure that the validator has announced themselves before we enter
        // the main validator submit loop. This is to avoid a situation in
        // which the validator is signing checkpoints but has not announced
        // their locations, which makes them functionally unusable.
        let validators: [H256; 1] = [self.signer.eth_address().into()];
        loop {
            info!("Checking for validator announcement");
            if let Some(locations) = self
                .validator_announce
                .get_announced_storage_locations(&validators)
                .await?
                .first()
            {
                if locations.contains(&self.checkpoint_syncer.announcement_location()) {
                    info!("Validator has announced signature storage location");
                    break;
                }
                info!(
                    announced_locations=?locations,
                    "Validator has not announced signature storage location"
                );

                if self.core.settings.chains[self.origin_chain.name()]
                    .signer
                    .is_some()
                {
                    let balance_delta = self
                        .validator_announce
                        .announce_tokens_needed(signed_announcement.clone())
                        .await
                        .unwrap_or_default();
                    if balance_delta > U256::zero() {
                        warn!(
                            tokens_needed=%balance_delta,
                            validator_address=?announcement.validator,
                            "Please send tokens to the validator address to announce",
                        );
                    } else {
                        let result = self
                            .validator_announce
                            .announce(signed_announcement.clone(), None)
                            .await;
                        Self::log_on_announce_failure(result);
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

#[cfg(test)]
mod test {}
