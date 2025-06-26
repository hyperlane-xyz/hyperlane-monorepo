use std::{collections::HashSet, fmt::Debug, hash::Hash, sync::Arc, time::Duration};

use eyre::Result as EyreResult;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, CheckpointWithMessageId, HyperlaneDomain,
    HyperlaneLogStore, HyperlaneMessage, Indexed, LogMeta, Mailbox, MultisigSignedCheckpoint,
    Signature, SignedCheckpointWithMessageId, TxOutcome, H256,
};
use tokio::{task::JoinHandle, time};
use tokio_metrics::TaskMonitor;
use tracing::{info, info_span, warn, Instrument};

use dym_kas_core::{confirmation::ConfirmationFXG, deposit::DepositFXG};
use dym_kas_relayer::deposit::on_new_deposit as relayer_on_new_deposit;
use dymension_kaspa::{Deposit, KaspaProvider};

use crate::{contract_sync::cursors::Indexable, db::HyperlaneRocksDB};

use hyperlane_cosmos_native::mailbox::CosmosNativeMailbox;

pub struct Foo<C: MetadataConstructor> {
    domain: HyperlaneDomain,
    kdb: HyperlaneRocksDB,
    provider: Box<KaspaProvider>,
    hub_mailbox: Arc<CosmosNativeMailbox>,
    metadata_constructor: C,
    deposit_cache: DepositCache,
}

impl<C: MetadataConstructor> Foo<C>
where
    C: Send + Sync + 'static,
{
    pub fn new(
        domain: HyperlaneDomain,
        kdb: HyperlaneRocksDB,
        provider: Box<KaspaProvider>,
        hub_mailbox: Arc<CosmosNativeMailbox>,
        metadata_constructor: C,
    ) -> Self {
        Self {
            domain,
            kdb,
            provider,
            hub_mailbox,
            metadata_constructor,
            deposit_cache: DepositCache::new(),
        }
    }

    pub fn run_deposit_loop(mut self, task_monitor: TaskMonitor) -> JoinHandle<()> {
        let name = "dymension_kaspa_deposit_loop";
        tokio::task::Builder::new()
            .name(name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    self.deposit_loop().await;
                }
                .instrument(info_span!("Kaspa Monitor")),
            ))
            .expect("Failed to spawn kaspa monitor task")
    }

    // https://github.com/dymensionxyz/hyperlane-monorepo/blob/20b9e669afcfb7728e66b5932e85c0f7fcbd50c1/dymension/libs/kaspa/lib/relayer/note.md#L102-L119
    async fn deposit_loop(&mut self) {
        loop {
            let deposits = self.provider.rest().get_deposits().await.unwrap();
            let deposits_new: Vec<Deposit> = deposits
                .into_iter()
                .filter(|deposit| !self.deposit_cache.has_seen(deposit))
                .collect::<Vec<_>>();

            for d in &deposits_new {
                self.deposit_cache.mark_as_seen(d.clone());
                info!("DYMENSION DEBUG: new deposit seen: {:?}", d);
            }

            for d in &deposits_new {
                // Call to relayer.F()
                let new_deposit_res = relayer_on_new_deposit(d).await;
                match new_deposit_res {
                    Ok(Some(fxg)) => {
                        let res = self.get_deposit_validator_sigs_and_send_to_hub(&fxg).await;
                        // TODO: check result
                    }
                    _ => {
                        // TODO: do somethign with error
                    }
                }
            }
            time::sleep(Duration::from_secs(10)).await;
        }
    }

    async fn get_deposit_validator_sigs_and_send_to_hub(
        &self,
        fxg: &DepositFXG,
    ) -> ChainResult<TxOutcome> {
        let msg = HyperlaneMessage::default(); // TODO: from depositsfx

        // network calls
        let mut sigs = self.provider.validators().get_deposit_sigs(fxg).await?;

        let formatted_sigs = self.format_checkpoint_signatures(
            &mut sigs,
            self.provider.validators().multisig_threshold_hub_ism() as usize,
        )?;

        self.hub_mailbox.process(&msg, &formatted_sigs, None).await
    }

    /// TODO: unused for now because we skirt the usual DB management
    /// if bringing back, see https://github.com/dymensionxyz/hyperlane-monorepo/blob/093dba37d696acc0c4440226c68f80dc85e42ce6/rust/main/hyperlane-base/src/kas_hack/logic_loop.rs#L92-L94
    async fn deposits_to_logs<T>(&self, _deposits: Vec<Deposit>) -> Vec<(Indexed<T>, LogMeta)>
    where
        T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
    {
        unimplemented!()
    }

    /// TODO: unused for now because we skirt the usual DB management
    async fn dedupe_and_store_logs<T, S>(
        &self,
        store: &S,
        logs: Vec<(Indexed<T>, LogMeta)>,
    ) -> Vec<(Indexed<T>, LogMeta)>
    where
        T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
        S: HyperlaneLogStore<T> + Clone + 'static,
    {
        // TODO: need to lock store?
        let deduped_logs = HashSet::<_>::from_iter(logs);
        let logs = Vec::from_iter(deduped_logs);

        if let Err(err) = store.store_logs(&logs).await {
            warn!(?err, "Error storing logs in db");
        }

        logs
    }

    // TODO: not used yet, and why would it be a loop?
    pub fn run_confirmation_loop(mut self, task_monitor: TaskMonitor) -> JoinHandle<()> {
        let name = "dymension_kaspa_confirmation_loop";
        tokio::task::Builder::new()
            .name(name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    self.confirmation_loop().await;
                }
                .instrument(info_span!("Kaspa Monitor")),
            ))
            .expect("Failed to spawn kaspa monitor task")
    }

    async fn confirmation_loop(&mut self) {
        loop {
            time::sleep(Duration::from_secs(10)).await;
        }
    }

    // TODO: this is a workaround for now because Michael works on the calling of it
    /*
    - [x] Can assume for time being that some other code will call my function on relayer, with the filled ProgressIndication
    - [x] Relayer will need to reach out to validators to gather the signatures over the progress indication
    - [x] Validator will need endpoint
    - [x] Validator will need to call VERIFY
    - [x] ProgressIndication will need to be converted to bytes/digest in same way as the hub does it
    - [x] Validator will need to sign appropriately TODO: check/fix/test this part
    - [x] Validator return
    - [x] Relayer post to hub
        */
    // needs to satisfy
    // https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/keeper/msg_server.go#L42-L48
    // https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/types/d.go#L76-L84
    pub async fn on_new_progress_indication(
        &self,
        fxg: &ConfirmationFXG,
    ) -> ChainResult<TxOutcome> {
        let progress_indication = &fxg.progress_indication;
        let mut sigs = self
            .provider
            .validators()
            .get_confirmation_sigs(fxg)
            .await?;

        let formatted_sigs = self.format_ad_hoc_signatures(
            &mut sigs,
            self.provider.validators().multisig_threshold_hub_ism() as usize,
        )?;

        self.hub_mailbox
            .indicate_progress(&formatted_sigs, progress_indication)
            .await
    }

    // TODO: can probably just use the ad hoc method
    fn format_checkpoint_signatures(
        &self,
        sigs: &mut Vec<SignedCheckpointWithMessageId>,
        require: usize,
    ) -> ChainResult<Vec<u8>> {
        if sigs.len() < require {
            return Err(ChainCommunicationError::InvalidRequest {
                msg: format!(
                    "insufficient validator signatures: got {}, need {}",
                    sigs.len(),
                    require
                ),
            });
        }

        let checkpoint = MultisigSignedCheckpoint::try_from(sigs).map_err(|_| {
            ChainCommunicationError::InvalidRequest {
                msg: "failed to convert sigs to checkpoint".to_string(),
            }
        })?;
        let metadata = self.metadata_constructor.metadata(&checkpoint)?;
        Ok(metadata.to_vec())
    }

    fn format_ad_hoc_signatures(
        &self,
        sigs: &mut Vec<Signature>,
        require: usize,
    ) -> ChainResult<Vec<u8>> {
        if sigs.len() < require {
            return Err(ChainCommunicationError::InvalidRequest {
                msg: format!(
                    "insufficient validator signatures: got {}, need {}",
                    sigs.len(),
                    require
                ),
            });
        }

        // Technically there is no need for checkpoint since it's not used in the metadata formatting,
        // so we can just create this directly
        let checkpoint = MultisigSignedCheckpoint {
            // this part not important (not used)!
            checkpoint: CheckpointWithMessageId {
                checkpoint: Checkpoint {
                    merkle_tree_hook_address: H256::default(),
                    mailbox_domain: 0,
                    root: H256::default(),
                    index: 0,
                },
                message_id: H256::default(),
            },
            // signatures are important
            signatures: sigs.clone(),
        };

        let metadata = self.metadata_constructor.metadata(&checkpoint)?;
        Ok(metadata.to_vec())
    }
}

struct DepositCache {
    seen: HashSet<Deposit>,
}

impl DepositCache {
    pub fn new() -> Self {
        Self {
            seen: HashSet::new(),
        }
    }

    fn has_seen(&self, deposit: &Deposit) -> bool {
        self.seen.contains(deposit)
    }

    fn mark_as_seen(&mut self, deposit: Deposit) {
        self.seen.insert(deposit);
    }
}

pub trait MetadataConstructor {
    fn metadata(&self, checkpoint: &MultisigSignedCheckpoint) -> EyreResult<Vec<u8>>;
}
