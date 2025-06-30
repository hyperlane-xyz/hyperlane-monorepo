use anyhow::Result;
use eyre::Result as EyreResult;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, CheckpointWithMessageId, HyperlaneDomain,
    HyperlaneLogStore, HyperlaneMessage, Indexed, LogMeta, Mailbox, MultisigSignedCheckpoint,
    Signature, SignedCheckpointWithMessageId, TxOutcome, H256,
};
use std::{collections::HashSet, fmt::Debug, hash::Hash, sync::Arc, time::Duration};
use tokio::{task::JoinHandle, time};
use tokio_metrics::TaskMonitor;
use tracing::{info, info_span, warn, Instrument};

use dym_kas_core::{confirmation::ConfirmationFXG, deposit::DepositFXG};
use dym_kas_relayer::deposit::on_new_deposit as relayer_on_new_deposit;
use dymension_kaspa::{Deposit, KaspaProvider};

use crate::{contract_sync::cursors::Indexable, db::HyperlaneRocksDB};

use hyperlane_cosmos_native::mailbox::CosmosNativeMailbox;

// Add imports for sync methods
use api_rs::apis::configuration::Configuration;
use dym_kas_relayer::confirmation::{prepare_progress_indication, trace_transactions};
use kaspa_consensus_core::tx::{TransactionId, TransactionOutpoint};

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

    /* -------------------------------------------------------------------------- */
    /*                                 sync logic                                 */
    /* -------------------------------------------------------------------------- */
    // TODO: move to a separate file

    /// Sync relayer that blocks until the system is synced
    /// Checks if the outpoint committed on the hub is already spent on Kaspa
    /// If not synced, prepares progress indication and submits to hub
    pub async fn sync_relayer_if_needed(&self) -> Result<()> {
        // get anchor utxo from hub
        let resp = self.hub_mailbox.provider().grpc().outpoint(None).await?;
        let anchor_utxo = resp
            .outpoint
            .map(|o| TransactionOutpoint {
                transaction_id: kaspa_hashes::Hash::from_bytes(
                    o.transaction_id.as_slice().try_into().unwrap(),
                ),
                index: o.index,
            })
            .ok_or_else(|| anyhow::anyhow!("No outpoint found"))?;

        // get all utxos from kaspa for the escrow address
        let escrow_address = self.provider.escrow_address();
        let utxos = self
            .provider
            .rpc()
            .get_utxos_by_addresses(vec![escrow_address])
            .await?;

        // check if the anchor utxo is in the utxos.
        // if it found, it's means we're synced.
        let is_synced = utxos.iter().any(|utxo| {
            utxo.outpoint.transaction_id == anchor_utxo.transaction_id
                && utxo.outpoint.index == anchor_utxo.index
        });
        if !is_synced {
            info!("System is not synced, preparing progress indication and submitting to hub");
            // we need to iterate over the utxos and find the next utxo of the escrow address
            let conf = self.provider.rest().get_config();

            let mut next_utxo = None;
            for utxo in utxos {
                let utxo_to_test = TransactionOutpoint::from(utxo.outpoint);
                let result = trace_transactions(&conf, utxo_to_test, anchor_utxo).await;
                if result.is_ok() {
                    next_utxo = Some(utxo_to_test);
                    break;
                }
            }
            let next_utxo = next_utxo.ok_or_else(|| anyhow::anyhow!("No suitable UTXO found"))?;
            self.run_sync_flow(anchor_utxo, next_utxo).await?;
        } 
        info!("System is synced, proceeding with other tasks");
        Ok(())
    }

    /// Handle sync requirement by preparing progress indication and submitting to hub
    /*
    - [x] Can assume for time being that some other code will call my function on relayer, with the filled ProgressIndication
    - [x] Relayer will need to reach out to validators to gather the signatures over the progress indication
    - [x] Validator will need endpoint
    - [x] Validator will need to call VERIFY
    - [x] ProgressIndication will need to be converted to bytes/digest in same way as the hub does it
    - [x] Validator will need to sign appropriately TODO: check/fix/test this part
    - [x] Validator return
    - [x] Relayer post to hub
    // needs to satisfy
    // https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/keeper/msg_server.go#L42-L48
    // https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/types/d.go#L76-L84
    */
    async fn run_sync_flow(&self, anchor_utxo: TransactionOutpoint, new_utxo: TransactionOutpoint) -> Result<()> {
        // Prepare progress indication
        let conf = self.provider.rest().get_config();
        let fxg = prepare_progress_indication(&conf, anchor_utxo, new_utxo).await?;

        let mut sigs = self
            .provider
            .validators()
            .get_confirmation_sigs(&fxg)
            .await?;

        let formatted_sigs = self.format_ad_hoc_signatures(
            &mut sigs,
            self.provider.validators().multisig_threshold_hub_ism() as usize,
        )?;

        self.hub_mailbox
            .indicate_progress(&formatted_sigs, &fxg.progress_indication)
            .await
            .map(|_| ())
            .map_err(|e| anyhow::anyhow!("Indicate progress failed: {}", e))?;

        Ok(())
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
