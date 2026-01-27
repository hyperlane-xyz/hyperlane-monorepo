use crate::contract_sync::cursors::Indexable;
use dym_kas_core::finality::is_safe_against_reorg;
use dymension_kaspa::hl_message::add_kaspa_metadata_hl_messsage;
use dymension_kaspa::ops::{confirmation::ConfirmationFXG, deposit::DepositFXG};
use dymension_kaspa::relayer::deposit::{build_deposit_fxg, check_deposit_finality, KaspaTxError};
use dymension_kaspa::{Deposit, KaspaProvider};
use ethers::utils::hex::ToHex;
use eyre::Result;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, CheckpointWithMessageId, HyperlaneChain,
    HyperlaneLogStore, Indexed, LogMeta, Mailbox, MultisigSignedCheckpoint, Signature,
    SignedCheckpointWithMessageId, TxOutcome, H256, U256,
};
use hyperlane_cosmos::native::{h512_to_cosmos_hash, CosmosNativeMailbox};
use std::{collections::HashSet, fmt::Debug, hash::Hash, sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, Mutex},
    task::JoinHandle,
    time,
};
use tokio_metrics::TaskMonitor;
use tracing::{debug, error, info, info_span, Instrument};

/// Channel for submitting deposits to be recovered/reprocessed
pub type DepositRecoverySender = mpsc::Sender<Deposit>;
pub type DepositRecoveryReceiver = mpsc::Receiver<Deposit>;

use super::{
    deposit_operation::{DepositOperation, DepositTracker},
    error::KaspaDepositError,
};
use dymension_kaspa::conf::RelayerDepositTimings;

enum DepositRelayResult {
    Success {
        deposit_id: String,
        amount: u64,
        hub_tx_hash: H256,
    },
    AlreadyDelivered {
        deposit_id: String,
    },
    Retryable {
        deposit_id: String,
        amount: u64,
        error: eyre::Error,
        custom_delay: Option<Duration>,
    },
    NonRetryable {
        deposit_id: String,
        amount: u64,
        error: eyre::Error,
    },
}

pub struct Foo<C: MetadataConstructor> {
    provider: Box<KaspaProvider>,
    hub_mailbox: Arc<CosmosNativeMailbox>,
    metadata_constructor: C,
    deposit_tracker: Mutex<DepositTracker>,
    config: RelayerDepositTimings,
    recovery_sender: DepositRecoverySender,
    recovery_receiver: Mutex<DepositRecoveryReceiver>,
}

impl<C: MetadataConstructor> Foo<C>
where
    C: Send + Sync + 'static,
{
    pub fn new(
        provider: Box<KaspaProvider>,
        hub_mailbox: Arc<CosmosNativeMailbox>,
        metadata_constructor: C,
    ) -> Self {
        // Get config from provider, or use defaults if not available
        let config = provider.must_relayer_stuff().deposit_timings.clone();
        // Channel for deposit recovery requests (buffer of 100 should be plenty)
        let (recovery_sender, recovery_receiver) = mpsc::channel(100);
        Self {
            provider,
            hub_mailbox,
            metadata_constructor,
            deposit_tracker: Mutex::new(DepositTracker::new()),
            config,
            recovery_sender,
            recovery_receiver: Mutex::new(recovery_receiver),
        }
    }

    /// Get a sender for submitting deposits to be recovered/reprocessed.
    /// This can be used by the server to submit old deposits that fell outside the lookback window.
    pub fn recovery_sender(&self) -> DepositRecoverySender {
        self.recovery_sender.clone()
    }

    /// Run deposit and progress indication loops
    pub fn run_loops(self, task_monitor: TaskMonitor) -> JoinHandle<()> {
        let foo = Arc::new(self);

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
        info!("Dymension, starting deposit loop with queue");

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("System time before Unix epoch")
            .as_millis() as i64;

        let mut from_time = Some(now - self.config.deposit_look_back.as_millis() as i64);
        let mut last_query_time = 0i64;

        loop {
            // Process any recovery requests first
            self.process_recovery_requests().await;

            self.process_deposit_queue().await;

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("System time before Unix epoch")
                .as_millis() as i64;

            let elapsed = now - last_query_time;
            let poll_interval_ms = self.config.poll_interval.as_millis() as i64;
            let to_sleep = poll_interval_ms.saturating_sub(elapsed);

            if to_sleep > 0 {
                time::sleep(Duration::from_millis(to_sleep as u64)).await;
            }

            last_query_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("System time before Unix epoch")
                .as_millis() as i64;

            match self
                .provider
                .rest()
                .get_deposits(
                    &self.provider.escrow_address().to_string(),
                    from_time,
                    self.provider.domain().id(),
                )
                .await
            {
                Ok(deposits) => {
                    self.queue_new_deposits(deposits).await;
                }
                Err(e) => {
                    error!(error = ?e, "Dymension, query new Kaspa deposits failed");
                }
            }

            from_time =
                Some(last_query_time - self.config.deposit_query_overlap.as_millis() as i64);
        }
    }

    /// Process any deposits submitted via the recovery channel
    async fn process_recovery_requests(&self) {
        let mut receiver = self.recovery_receiver.lock().await;
        while let Ok(deposit) = receiver.try_recv() {
            info!(
                deposit_id = %deposit.id,
                "Processing deposit recovery request"
            );
            self.queue_new_deposits(vec![deposit]).await;
        }
    }

    async fn queue_new_deposits(&self, deposits: Vec<Deposit>) {
        let escrow_address = self.provider.escrow_address().to_string();
        let mut tracker = self.deposit_tracker.lock().await;
        let mut new_count = 0;

        for dep in deposits {
            if tracker.track(dep.clone(), escrow_address.clone()) {
                info!(deposit = ?dep, "Dymension, new deposit seen");
                new_count += 1;
            }
        }

        drop(tracker);

        if new_count > 0 {
            info!(
                deposit_count = new_count,
                "Dymension, queried new kaspa deposits"
            );
            if let Err(e) = self.provider.update_balance_metrics().await {
                error!("Failed to update balance metrics: {:?}", e);
            }
        }
    }

    /// Process the retry queue for failed deposit operations
    async fn process_deposit_queue(&self) {
        loop {
            let op = {
                let mut tracker = self.deposit_tracker.lock().await;
                tracker.pop_ready()
            };

            match op {
                Some(operation) => {
                    self.try_relay_deposit(operation).await;
                }
                None => break,
            }
        }
    }

    /// Decode deposit payload into Hyperlane message with Kaspa metadata
    fn decode_and_add_kaspa_metadata(
        &self,
        deposit: &Deposit,
        escrow_address: &str,
    ) -> Result<(hyperlane_core::HyperlaneMessage, u64, usize), eyre::Error> {
        use dymension_kaspa::hl_message::ParsedHL;

        let payload = deposit
            .payload
            .as_ref()
            .ok_or_else(|| eyre::eyre!("Deposit has no payload"))?;

        let parsed_hl = ParsedHL::parse_string(payload)?;
        let amt_hl = parsed_hl.token_message.amount();

        // Find the index of the UTXO that satisfies the transfer amount in HL message
        let utxo_index = deposit
            .outputs
            .iter()
            .position(|utxo| {
                U256::from(utxo.amount) >= amt_hl
                    && utxo
                        .script_public_key_address
                        .as_ref()
                        .map(|addr| addr == escrow_address)
                        .unwrap_or(false)
            })
            .ok_or_else(|| {
                eyre::eyre!(
                    "kaspa deposit {} had insufficient sompi amount or no matching escrow output",
                    deposit.id
                )
            })?;

        // Add Kaspa metadata to the Hyperlane message
        let hl_message_with_metadata =
            add_kaspa_metadata_hl_messsage(parsed_hl, deposit.id, utxo_index)?;
        let amount = amt_hl.low_u64();

        Ok((hl_message_with_metadata, amount, utxo_index))
    }

    async fn try_relay_deposit(&self, mut op: DepositOperation) {
        info!(deposit_id = %op.deposit.id, "Processing deposit operation");

        match self.try_relay_deposit_inner(&op).await {
            DepositRelayResult::Success {
                deposit_id,
                amount,
                hub_tx_hash,
            } => {
                // Metrics are recorded inside try_relay_deposit_inner with timing info
                info!(
                    deposit_id = %deposit_id,
                    hub_tx_hash = ?hub_tx_hash,
                    amount = %amount,
                    "Deposit successfully processed and relayed to hub"
                );
            }
            DepositRelayResult::AlreadyDelivered { deposit_id } => {
                info!(
                    deposit_id = %deposit_id,
                    "Deposit already delivered, skipping"
                );
            }
            DepositRelayResult::Retryable {
                deposit_id,
                amount,
                error,
                custom_delay,
            } => {
                self.provider
                    .metrics()
                    .record_deposit_failed(&deposit_id, amount);
                op.mark_failed(&self.config, custom_delay);
                self.deposit_tracker.lock().await.requeue(op);
                error!(
                    deposit_id = %deposit_id,
                    error = ?error,
                    "Deposit processing error (retryable), requeued"
                );
            }
            DepositRelayResult::NonRetryable {
                deposit_id,
                amount,
                error,
            } => {
                self.provider
                    .metrics()
                    .record_deposit_failed(&deposit_id, amount);
                error!(
                    deposit_id = %deposit_id,
                    error = ?error,
                    "Deposit processing error (non-retryable), dropping"
                );
            }
        }
    }

    async fn try_relay_deposit_inner(&self, op: &DepositOperation) -> DepositRelayResult {
        let deposit_id = format!("{:?}", op.deposit.id);

        // Step 1: Get the HL message and add kaspa metadata
        let (hl_message, amount, utxo_index) =
            match self.decode_and_add_kaspa_metadata(&op.deposit, &op.escrow_address) {
                Ok(v) => v,
                Err(error) => {
                    return DepositRelayResult::NonRetryable {
                        deposit_id,
                        amount: 0,
                        error,
                    }
                }
            };

        // Step 2: Check if already delivered (before expensive finality check)
        match self.hub_mailbox.delivered(hl_message.id()).await {
            Ok(true) => {
                return DepositRelayResult::AlreadyDelivered { deposit_id };
            }
            Err(e) => {
                return DepositRelayResult::Retryable {
                    deposit_id,
                    amount,
                    error: eyre::eyre!("Check if deposit is delivered: {}", e),
                    custom_delay: None,
                };
            }
            _ => {}
        }

        // Step 3: Save to DB
        self.provider.store_deposit(&hl_message, &deposit_id);

        // Step 4: Check finality
        if let Err(e) =
            check_deposit_finality(&op.deposit, &self.provider.rest().client.client).await
        {
            let kaspa_err = KaspaDepositError::from(e);
            let custom_delay = kaspa_err
                .retry_delay_hint()
                .map(|secs| Duration::from_secs_f64(secs));
            return DepositRelayResult::Retryable {
                deposit_id,
                amount,
                error: eyre::eyre!("{}", kaspa_err),
                custom_delay,
            };
        }

        // Step 5: Build FXG for validators
        let fxg = build_deposit_fxg(hl_message, U256::from(amount), utxo_index, &op.deposit);
        info!(fxg = ?fxg, "Built deposit FXG");

        // Step 6: Get signatures and relay
        let outcome = match self.get_deposit_validator_sigs_and_send_to_hub(&fxg).await {
            Ok(outcome) => outcome,
            Err(e) => {
                let kaspa_err = self.chain_error_to_kaspa_error(&e);
                return if kaspa_err.is_retryable() {
                    DepositRelayResult::Retryable {
                        deposit_id,
                        amount,
                        error: eyre::eyre!("Gather sigs and send deposit to hub: {}", e),
                        custom_delay: None,
                    }
                } else {
                    DepositRelayResult::NonRetryable {
                        deposit_id,
                        amount,
                        error: eyre::eyre!("Gather sigs and send deposit to hub: {}", e),
                    }
                };
            }
        };

        if !outcome.executed {
            let tx_hash = hyperlane_cosmos::native::h512_to_cosmos_hash(outcome.transaction_id)
                .encode_hex_upper::<String>();
            return DepositRelayResult::Retryable {
                deposit_id,
                amount,
                error: eyre::eyre!(
                    "TX was not executed on-chain, tx hash: {}, gas used: {}",
                    tx_hash,
                    outcome.gas_used
                ),
                custom_delay: None,
            };
        }

        // Step 7: Save hub tx to DB and record metrics
        let hub_tx_hash = hyperlane_cosmos::native::h512_to_h256(outcome.transaction_id);
        self.provider
            .update_processed_deposit(&deposit_id, fxg.hl_message, &hub_tx_hash);

        // Record deposit metrics with timing from operation creation
        self.provider
            .metrics()
            .record_deposit_processed(&deposit_id, amount, op.created_at);

        DepositRelayResult::Success {
            deposit_id,
            amount,
            hub_tx_hash,
        }
    }

    async fn progress_indication_loop(&self) {
        // Confirmation list structure before IndicateProgress is called on Hub:
        // prev: 100, next: 101
        // prev: 100, next: 102
        // prev: 100, next: 103
        // All prev_outpoint are same since Hub last outpoint doesn't change.
        // Process only the last confirmation. If Hub outpoint != prev_outpoint,
        // Hub moved forward - clear confirmation list and get new ones next iteration.
        loop {
            let conf = self.provider.get_pending_confirmation().await;

            match conf {
                Some(conf) => {
                    let result = self.confirm_withdrawal_on_hub(conf.clone()).await;
                    match result {
                        Ok(_) => {
                            info!(confirmation = ?conf, "Dymension, confirmed withdrawal on hub");
                            self.provider.metrics().update_confirmations_pending(0);
                            self.provider.consume_pending_confirmation();

                            if let Err(e) = self.update_hub_anchor_point_metric().await {
                                error!(error = ?e, "Failed to update hub anchor point metric after successful confirmation");
                            }
                        }
                        Err(KaspaTxError::NotFinalError {
                            retry_after_secs, ..
                        }) => {
                            info!(
                                retry_after_secs = retry_after_secs,
                                "Dymension, withdrawal not final yet, sleeping before retry"
                            );
                            self.provider.metrics().update_confirmations_pending(1);
                            time::sleep(Duration::from_secs_f64(retry_after_secs)).await;
                            continue;
                        }
                        Err(e) => {
                            error!("Dymension, confirm withdrawal on hub: {:?}", e);
                            self.provider.metrics().record_confirmation_failed();
                        }
                    }
                }
                None => {
                    info!("Dymension, no pending confirmation found.");
                }
            }

            time::sleep(self.config.poll_interval).await;
        }
    }

    async fn get_deposit_validator_sigs_and_send_to_hub(
        &self,
        fxg: &DepositFXG,
    ) -> ChainResult<TxOutcome> {
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

    fn chain_error_to_kaspa_error(&self, err: &ChainCommunicationError) -> KaspaDepositError {
        KaspaDepositError::ProcessingError(err.to_string())
    }

    async fn _deposits_to_logs<T>(&self, _deposits: Vec<Deposit>) -> Vec<(Indexed<T>, LogMeta)>
    where
        T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
    {
        unimplemented!()
    }

    // Unused - Kaspa bridge bypasses normal DB management for deposits/withdrawals
    async fn _dedupe_and_store_logs<T, S>(
        &self,
        s: &S,
        logs: Vec<(Indexed<T>, LogMeta)>,
    ) -> Vec<(Indexed<T>, LogMeta)>
    where
        T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
        S: HyperlaneLogStore<T> + Clone + 'static,
    {
        let deduped = HashSet::<_>::from_iter(logs);
        let logs = Vec::from_iter(deduped);

        if let Err(e) = s.store_logs(&logs).await {
            debug!(error = ?e, "Error storing logs in db");
        }

        logs
    }

    // Check if Hub's committed outpoint is already spent on Kaspa chain.
    // If not synced, prepare progress indication and submit to Hub.
    pub async fn sync_hub_if_needed(&self) -> Result<()> {
        let escrow_str = self.provider.escrow_address().to_string();
        let min_sigs = self.provider.validators().multisig_threshold_hub_ism() as usize;

        // Create signature formatter closure
        let format_sigs = |sigs: &mut Vec<Signature>| -> ChainResult<Vec<u8>> {
            self.format_ad_hoc_signatures(sigs, min_sigs)
        };

        super::sync::ensure_hub_synced(
            &self.provider,
            &self.hub_mailbox,
            &escrow_str,
            &escrow_str,
            format_sigs,
        )
        .await?;

        if let Err(e) = self.update_hub_anchor_point_metric().await {
            error!(error = ?e, "Failed to update hub anchor point metric after syncing");
        }

        Ok(())
    }

    async fn update_hub_anchor_point_metric(&self) -> Result<()> {
        use hyperlane_cosmos::{native::ModuleQueryClient, CosmosProvider};
        let prov = self.hub_mailbox.provider();
        let cosmos_prov = prov
            .as_any()
            .downcast_ref::<CosmosProvider<ModuleQueryClient>>()
            .expect("Hub mailbox provider must be CosmosProvider");
        let resp = cosmos_prov.query().outpoint(None).await?;

        if let Some(op) = resp.outpoint {
            let tx_id = kaspa_hashes::Hash::from_bytes(
                op.transaction_id
                    .as_slice()
                    .try_into()
                    .map_err(|e| eyre::eyre!("Invalid transaction ID bytes: {:?}", e))?,
            );
            let ts = kaspa_core::time::unix_now();

            self.provider.metrics().update_hub_anchor_point(
                &tx_id.to_string(),
                op.index as u64,
                ts,
            );

            info!(
                tx_id = %tx_id,
                outpoint_index = op.index,
                "Updated hub anchor point metric"
            );
        } else {
            error!("No anchor point found in hub response");
        }

        Ok(())
    }

    // Needs to satisfy Hub validation:
    // - https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/keeper/msg_server.go#L42-L48
    // - https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/types/d.go#L76-L84
    async fn confirm_withdrawal_on_hub(&self, fxg: ConfirmationFXG) -> Result<(), KaspaTxError> {
        // Use the last outpoint (new anchor) from the withdrawal sequence
        let anchor_new = fxg.outpoints.last().ok_or_else(|| {
            KaspaTxError::ProcessingError(eyre::eyre!("No outpoints in confirmation FXG"))
        })?;

        let finality = is_safe_against_reorg(
            &self.provider.rest().client.client,
            &anchor_new.transaction_id.to_string(),
            None,
        )
        .await
        .map_err(|e| KaspaTxError::ProcessingError(e))?;

        if !finality.is_final() {
            return Err(KaspaTxError::NotFinalError {
                confirmations: finality.confirmations,
                required_confirmations: finality.required_confirmations,
                retry_after_secs: (finality.required_confirmations - finality.confirmations) as f64
                    * 0.1,
            });
        }

        info!(
            confirmations = finality.confirmations,
            required = finality.required_confirmations,
            "Finality check passed for withdrawal confirmation"
        );

        let mut sigs = self
            .provider
            .validators()
            .get_confirmation_sigs(&fxg)
            .await
            .map_err(|e| {
                KaspaTxError::ProcessingError(eyre::eyre!("Failed to get confirmation sigs: {}", e))
            })?;

        info!(sig_count = sigs.len(), "Dymension, got confirmation sigs");
        let formatted = self
            .format_ad_hoc_signatures(
                &mut sigs,
                self.provider.validators().multisig_threshold_hub_ism() as usize,
            )
            .map_err(|e| {
                KaspaTxError::ProcessingError(eyre::eyre!("Failed to format signatures: {}", e))
            })?;

        info!("Dymension, formatted confirmation sigs: {:?}", formatted);

        let outcome = self
            .hub_mailbox
            .indicate_progress(&formatted, &fxg.progress_indication)
            .await
            .map_err(|e| {
                KaspaTxError::ProcessingError(eyre::eyre!("Indicate progress failed: {}", e))
            })?;

        let tx_hash = h512_to_cosmos_hash(outcome.transaction_id).encode_hex_upper::<String>();

        if !outcome.executed {
            return Err(KaspaTxError::ProcessingError(eyre::eyre!(
                "Indicate progress failed, TX was not executed on-chain, tx hash: {tx_hash}"
            )));
        }

        info!(
            "Dymension, indicated progress on hub: {:?}, outcome: {:?}, tx hash: {:?}",
            fxg.progress_indication, outcome, tx_hash,
        );

        Ok(())
    }

    // for deposits
    fn format_checkpoint_signatures(
        &self,
        sigs: &mut Vec<SignedCheckpointWithMessageId>,
        min: usize,
    ) -> ChainResult<Vec<u8>> {
        if sigs.len() < min {
            return Err(ChainCommunicationError::InvalidRequest {
                msg: format!(
                    "insufficient validator signatures: got {}, need {}",
                    sigs.len(),
                    min
                ),
            });
        }

        let ckpt = MultisigSignedCheckpoint::try_from(sigs).map_err(|_| {
            ChainCommunicationError::InvalidRequest {
                msg: "to convert sigs to checkpoint".to_string(),
            }
        })?;
        let meta = self.metadata_constructor.metadata(&ckpt)?;
        Ok(meta.to_vec())
    }

    // for withdrawal confirmations
    fn format_ad_hoc_signatures(
        &self,
        sigs: &mut Vec<Signature>,
        min: usize,
    ) -> ChainResult<Vec<u8>> {
        if sigs.len() < min {
            return Err(ChainCommunicationError::InvalidRequest {
                msg: format!(
                    "insufficient validator signatures: got {}, need {}",
                    sigs.len(),
                    min
                ),
            });
        }

        // Checkpoint struct not actually used in metadata formatting, only signatures matter.
        // Create directly without needing real checkpoint data.
        let ckpt = MultisigSignedCheckpoint {
            checkpoint: CheckpointWithMessageId {
                checkpoint: Checkpoint {
                    merkle_tree_hook_address: H256::default(),
                    mailbox_domain: 0,
                    root: H256::default(),
                    index: 0,
                },
                message_id: H256::default(),
            },
            signatures: sigs.clone(),
        };

        let meta = self.metadata_constructor.metadata(&ckpt)?;
        Ok(meta.to_vec())
    }
}

pub trait MetadataConstructor {
    fn metadata(&self, ckpt: &MultisigSignedCheckpoint) -> Result<Vec<u8>>;
}
