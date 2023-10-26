use std::{num::NonZeroU64, sync::Arc, time::Duration};

use async_trait::async_trait;
use derive_more::AsRef;
use eyre::Result;
use futures_util::future::ready;
use hyperlane_cosmos::verify::{priv_to_addr_string, priv_to_binary_addr};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{error, info, info_span, instrument::Instrumented, warn, Instrument};

use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    run_all,
    settings::SignerConf,
    BaseAgent, CheckpointSyncer, ContractSyncMetrics, CoreMetrics, HyperlaneAgentCore,
    WatermarkContractSync,
};

use hyperlane_core::{
    Announcement, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneSigner,
    HyperlaneSignerExt, Mailbox, MerkleTreeHook, MerkleTreeInsertion, TxOutcome, ValidatorAnnounce,
    H256, U256,
};
use hyperlane_ethereum::{SingletonSigner, SingletonSignerHandle};

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
    raw_signer: SignerConf,
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
            raw_signer: settings.validator.clone(),
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

        let reorg_period = NonZeroU64::new(self.reorg_period);
        let tip_tree = self
            .merkle_tree_hook
            .tree(reorg_period)
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

    fn log_on_announce_failure(result: ChainResult<TxOutcome>) {
        match result {
            Ok(outcome) => {
                if outcome.executed {
                    info!(
                        tx_outcome=?outcome,
                        "Successfully announced validator",
                    );
                } else {
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
                    "Failed to announce validator. Make sure you have enough funds in your account to pay for gas."
                );
            }
        }
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
                    let balance_delta = self
                        .validator_announce
                        .announce_tokens_needed(signed_announcement.clone())
                        .await
                        .unwrap_or_default();
                    if balance_delta > U256::zero() {
                        warn!(
                            tokens_needed=%balance_delta,
                            eth_validator_address=?announcement.validator,
                            chain_signer=?chain_signer.address(),
                            "Please send tokens to your chain signer address to announce",
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
mod test {
    use std::str::FromStr;

    use ethers::{
        signers::Wallet,
        utils::{self},
    };
    use hyperlane_core::{Announcement, HyperlaneSigner, Signable, H256};
    use hyperlane_ethereum::Signers;
    use k256::ecdsa::SigningKey;

    #[tokio::test]
    async fn sign_manual() -> eyre::Result<()> {
        let test_key = "45bde72a537e11d1cef58836d9278268fd393c0400852ce045fc0c2de7bbe90d";

        let cases = [(
            "0xf9e25a6be80f6d48727e42381fc3c3b7834c0cb4",
            "0xcb4530690c80917c7e412498e7258fff4569857b2aae8e020091cf2d75730656",
            26657,
            "file:///var/folders/3v/g38z040x54x8l6b160vv66b40000gn/T/.tmpY4ofw1/checkpoint",
        )];

        let to_announcement = |c: (&str, &str, u32, &str)| -> eyre::Result<Announcement> {
            let validator = hyperlane_core::H160::from_str(c.0)?;
            let mailbox_address = hyperlane_core::H256::from_str(c.1)?;
            let mailbox_domain = c.2;
            let storage_location = c.3.to_string();

            Ok(Announcement {
                validator,
                mailbox_address,
                mailbox_domain,
                storage_location,
            })
        };

        for c in cases {
            let announcement = to_announcement(c)?;
            let hash = announcement.signing_hash();

            // eth sign
            let eth_signer = Signers::Local(Wallet::from_str(test_key)?);
            let eth_sign = eth_signer.sign_hash(&hash).await?;
            let eth_sign_raw = eth_sign.to_vec();

            // raw sign
            let cosmos_sign_raw = {
                let signing_key =
                    SigningKey::from_bytes(H256::from_str(test_key)?.as_bytes().into())?;

                let message = hash.as_ref();
                let message_hash = utils::hash_message(message); // ERC-191

                let (sign, recov) =
                    signing_key.sign_prehash_recoverable(message_hash.as_bytes())?;

                let mut sign_raw = sign.to_vec();
                sign_raw.push(recov.to_byte() + 27); // ERC-155

                sign_raw
            };

            assert_eq!(eth_sign_raw, cosmos_sign_raw);
        }

        Ok(())
    }
}
