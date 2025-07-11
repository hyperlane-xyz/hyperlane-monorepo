use eyre::Result;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, CheckpointWithMessageId, HyperlaneDomain,
    HyperlaneLogStore, HyperlaneMessage, Indexed, LogMeta, Mailbox, MultisigSignedCheckpoint,
    Signature, SignedCheckpointWithMessageId, TxOutcome, H256,
};
use std::{collections::HashSet, fmt::Debug, hash::Hash, sync::Arc, time::Duration};
use tokio::{sync::Mutex, task::JoinHandle, time};
use tokio_metrics::TaskMonitor;
use tracing::{error, info, info_span, warn, Instrument};

use dym_kas_core::{confirmation::ConfirmationFXG, deposit::DepositFXG};
use dym_kas_relayer::deposit::on_new_deposit as relayer_on_new_deposit;
use dymension_kaspa::{Deposit, KaspaProvider};

use crate::{contract_sync::cursors::Indexable, db::HyperlaneRocksDB};

use hyperlane_cosmos_native::mailbox::CosmosNativeMailbox;
use kaspa_core::time::unix_now;

use api_rs::apis::configuration::Configuration;
use dym_kas_relayer::confirm::expensive_trace_transactions;
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

    /// Run deposit and progress indication loops
    pub fn run_loops(self, task_monitor: TaskMonitor) -> JoinHandle<()> {
        // Wrap self in an `Arc` so we can share an immutable reference between the two tasks.
        let foo = Arc::new(self);

        /* -------------------------------- deposit loop ------------------------------- */
        {
            let foo_clone = foo.clone();
            let name = "dymension_kaspa_deposit_loop";
            tokio::task::Builder::new()
                .name(name)
                .spawn(TaskMonitor::instrument(
                    &task_monitor,
                    async move {
                        foo_clone.deposit_loop().await;
                    }
                    .instrument(info_span!("Kaspa Monitor")),
                ))
                .expect("Failed to spawn kaspa monitor task");
        }

        /* ------------------------ progress indication loop ------------------------ */
        {
            let foo_clone = foo.clone();
            let name = "dymension_kaspa_progress_indication_loop";
            tokio::task::Builder::new()
                .name(name)
                .spawn(TaskMonitor::instrument(
                    &task_monitor,
                    async move {
                        foo_clone.progress_indication_loop().await;
                    }
                    .instrument(info_span!("Kaspa Monitor")),
                ))
                .expect("Failed to spawn kaspa progress indication task")
        }
    }

    // https://github.com/dymensionxyz/hyperlane-monorepo/blob/20b9e669afcfb7728e66b5932e85c0f7fcbd50c1/dymension/libs/kaspa/lib/relayer/note.md#L102-L119
    async fn deposit_loop(&self) {
        info!("Dymension, starting deposit loop");
        let lower_bound_unix_time: Option<i64> = match self
            .provider
            .rest()
            .conf
            .relayer_stuff
            .as_ref()
            .unwrap()
            .deposit_look_back_mins
        {
            Some(offset) => {
                let secs = offset * 60;
                let d = Duration::new(secs, 0);
                Some(unix_now() as i64 - d.as_millis() as i64)
            }
            None => None, // unbounded
        };
        loop {
            time::sleep(Duration::from_secs(20)).await;
            let deposits_res = self
                .provider
                .rest()
                .get_deposits(lower_bound_unix_time)
                .await;
            let deposits = match deposits_res {
                Ok(deposits) => deposits,
                Err(e) => {
                    error!("Query new Kaspa deposits: {:?}", e);
                    continue;
                }
            };

            info!("Dymension, queried kaspa deposits, n: {:?}", deposits.len());

            let mut deposits_new = Vec::new();
            for d in deposits.into_iter() {
                if !self.deposit_cache.has_seen(&d).await {
                    info!("Dymension, new deposit seen: {:?}", d.clone());
                    self.deposit_cache.mark_as_seen(d.clone()).await;
                    deposits_new.push(d);
                }
            }

            for d in &deposits_new {
                // Call to relayer.F()
                let new_deposit_res =
                    relayer_on_new_deposit(&self.provider.escrow_address().to_string(), d).await;
                info!("Dymension, built new deposit FXG: {:?}", new_deposit_res);
                match new_deposit_res {
                    Ok(Some(fxg)) => {
                        let res = self.get_deposit_validator_sigs_and_send_to_hub(&fxg).await;
                        match res {
                            Ok(_) => {
                                info!("Dymension, got sigs and sent new deposit to hub: {:?}", fxg);
                            }
                            Err(e) => {
                                error!("Dymension, gather sigs and send deposit to hub: {:?}", e);
                                // TODO: should have a retry flow
                            }
                        }
                    }
                    Ok(None) => {
                        error!("Dymension, F() new deposit returned none, dropping deposit.");
                    }
                    Err(e) => {
                        error!("Dymension, F() new deposit: {:?}, dropping deposit.", e);
                    }
                }
            }
        }
    }

    async fn progress_indication_loop(&self) {
        loop {
            // The confirmation list always looks like this:
            // ---
            // prev: 100
            // next: 101
            // ---
            // prev: 100
            // next: 102
            // ---
            // prev: 100
            // next: 103
            // ---
            // It means that before IndicateProgress is called, all prev_outpoint are the same
            // as the Hub last outpoint doesn't change. It's enough to process the last confirmation.
            //
            // If, for some reason, the last Hub outpoint != prev_outpoint, then the Hub went forward.
            // We clear the confirmation list, and on the next iteration we will have new confirmations
            // with the correct outpoints.
            //
            // TODO: what happens if at some point no one is bridging and we have failed confirmations?
            let confirmation = self.provider.consume_pending_confirmation();

            match confirmation {
                Some(confirmation) => {
                    let res = self.confirm_withdrawal_on_hub(confirmation.clone()).await;
                    match res {
                        Ok(_) => {
                            info!("Dymension, confirmed withdrawal on hub: {:?}", confirmation);
                        }
                        Err(e) => {
                            error!("Dymension, confirm withdrawal on hub: {:?}", e);
                        }
                    }
                }
                None => {}
            }

            time::sleep(Duration::from_secs(10)).await;
        }
    }

    async fn get_deposit_validator_sigs_and_send_to_hub(
        &self,
        fxg: &DepositFXG,
    ) -> ChainResult<TxOutcome> {
        // network calls
        let mut sigs = self.provider.validators().get_deposit_sigs(fxg).await?;
        info!(
            "Dymension, got deposit sigs: number of sigs: {:?}",
            sigs.len()
        );

        let formatted_sigs = self.format_checkpoint_signatures(
            &mut sigs,
            self.provider.validators().multisig_threshold_hub_ism() as usize,
        )?;

        self.hub_mailbox
            .process(&fxg.hl_message, &formatted_sigs, None)
            .await
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

    /// Checks if the outpoint committed on the hub is already spent on Kaspa
    /// If not synced, prepares progress indication and submits to hub
    pub async fn sync_hub_if_needed(&self) -> Result<()> {
        info!("Checking if hub is out of sync with Kaspa escrow account.");
        // get anchor utxo from hub
        let resp = self.hub_mailbox.provider().grpc().outpoint(None).await?;
        let old_anchor = resp
            .outpoint
            .map(|o| TransactionOutpoint {
                transaction_id: kaspa_hashes::Hash::from_bytes(
                    o.transaction_id.as_slice().try_into().unwrap(),
                ),
                index: o.index,
            })
            .ok_or_else(|| eyre::eyre!("No outpoint found"))?;

        info!("Dymension, current anchor: {:?}", old_anchor);

        // get all utxos from kaspa for the escrow address
        let escrow_address = self.provider.escrow_address();
        let all_escrow_utxos = self
            .provider
            .rpc()
            .get_utxos_by_addresses(vec![escrow_address.clone()])
            .await?;

        // check if the anchor utxo is in the utxos.
        // if it found, it's means we're synced.
        let hub_is_synced = all_escrow_utxos.iter().any(|utxo| {
            let ok = utxo.outpoint.transaction_id == old_anchor.transaction_id
                && utxo.outpoint.index == old_anchor.index;
            if ok {
                info!("Dymension, found utxo matching current anchor: {:?}", utxo);
            }
            ok
        });
        if !hub_is_synced {
            info!("Dymension is not synced, preparing progress indication and submitting to hub");
            // we need to iterate over the utxos and find the next utxo of the escrow address

            let mut good = false;
            for utxo in all_escrow_utxos {
                let candidate_new_anchor = TransactionOutpoint::from(utxo.outpoint);
                let fxg = expensive_trace_transactions(
                    &self.provider.rest().client.client,
                    &escrow_address.to_string(),
                    candidate_new_anchor.clone(),
                    old_anchor,
                )
                .await;
                if !fxg.is_ok() {
                    error!(
                        "Dymension, invalid confirmation candidate: error tracing sequence of kaspa withdrawals for syncing: {:?}, candidate: {:?}",
                        fxg.err(),
                        candidate_new_anchor,
                    );
                    continue;
                }
                info!("Traced sequence of kaspa withdrawals for syncing");

                /*
                TODO: need to try again here if validators are not unavailable etc, rather than just returning an error and thus a crash
                  */
                self.confirm_withdrawal_on_hub(fxg.unwrap()).await?;
                good = true;
                break;
            }
            if !good {
                return Err(eyre::eyre!("Dymension, no good utxo found for syncing"));
            }
        }
        info!("Dymension hub is synced, proceeding with other tasks");
        Ok(())
    }

    /// Handle sync requirement by preparing progress indication and submitting to hub
    /// needs to satisfy
    /// https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/keeper/msg_server.go#L42-L48
    /// https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/types/d.go#L76-L84
    async fn confirm_withdrawal_on_hub(&self, fxg: ConfirmationFXG) -> Result<()> {
        let mut sigs = self
            .provider
            .validators()
            .get_confirmation_sigs(&fxg)
            .await?;

        info!("Dymension, got confirmation sigs: {:?}", sigs);
        let formatted_sigs = self.format_ad_hoc_signatures(
            &mut sigs,
            self.provider.validators().multisig_threshold_hub_ism() as usize,
        )?;

        info!(
            "Dymension, formatted confirmation sigs: {:?}",
            formatted_sigs
        );

        let outcome = self
            .hub_mailbox
            .indicate_progress(&formatted_sigs, &fxg.progress_indication)
            .await
            .map_err(|e| eyre::eyre!("Indicate progress failed: {}", e))?;

        info!(
            "Dymension, indicated progress on hub: {:?}, outcome: {:?}",
            fxg.progress_indication, outcome
        );

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
                msg: "to convert sigs to checkpoint".to_string(),
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

pub struct DepositCache {
    seen: Mutex<HashSet<Deposit>>,
}

impl DepositCache {
    pub fn new() -> Self {
        Self {
            seen: Mutex::new(HashSet::new()),
        }
    }

    async fn has_seen(&self, deposit: &Deposit) -> bool {
        let seen_guard = self.seen.lock().await;
        seen_guard.contains(deposit)
    }

    async fn mark_as_seen(&self, deposit: Deposit) {
        let mut seen_guard = self.seen.lock().await;
        seen_guard.insert(deposit);
    }
}

pub trait MetadataConstructor {
    fn metadata(&self, checkpoint: &MultisigSignedCheckpoint) -> Result<Vec<u8>>;
}
