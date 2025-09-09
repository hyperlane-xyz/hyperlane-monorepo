use crate::contract_sync::cursors::Indexable;
use dym_kas_core::{
    confirmation::ConfirmationFXG, deposit::DepositFXG, finality::is_safe_against_reorg,
};
use dym_kas_relayer::confirm::expensive_trace_transactions;
use dym_kas_relayer::deposit::{on_new_deposit as relayer_on_new_deposit, KaspaTxError};
use dymension_kaspa::{Deposit, KaspaProvider};
use ethers::utils::hex::ToHex;
use eyre::Result;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, CheckpointWithMessageId, HyperlaneLogStore,
    Indexed, LogMeta, Mailbox, MultisigSignedCheckpoint, Signature, SignedCheckpointWithMessageId,
    TxOutcome, H256,
};
use hyperlane_cosmos_native::h512_to_cosmos_hash;
use hyperlane_cosmos_native::mailbox::CosmosNativeMailbox;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_core::time::unix_now;
use std::{collections::HashSet, fmt::Debug, hash::Hash, sync::Arc, time::Duration};
use tokio::{sync::Mutex, task::JoinHandle, time};
use tokio_metrics::TaskMonitor;
use tracing::{debug, error, info, info_span, warn, Instrument};

use super::{
    deposit_operation::{DepositOpQueue, DepositOperation},
    error::KaspaDepositError,
};
use dymension_kaspa::conf::KaspaTimeConfig;

pub struct Foo<C: MetadataConstructor> {
    provider: Box<KaspaProvider>,
    hub_mailbox: Arc<CosmosNativeMailbox>,
    metadata_constructor: C,
    deposit_cache: DepositCache,
    deposit_queue: Mutex<DepositOpQueue>,
    config: KaspaTimeConfig,
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
        let config = provider
            .kaspa_time_config()
            .unwrap_or_else(KaspaTimeConfig::default);
        Self {
            provider,
            hub_mailbox,
            metadata_constructor,
            deposit_cache: DepositCache::new(),
            deposit_queue: Mutex::new(DepositOpQueue::new()),
            config,
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
        info!("Dymension, starting deposit loop with queue");
        let lower_bound_unix_time: Option<i64> =
            match self.provider.must_relayer_stuff().deposit_look_back_mins {
                Some(offset) => {
                    let secs = offset * 60;
                    let d = Duration::new(secs, 0);
                    Some(unix_now() as i64 - d.as_millis() as i64)
                }
                None => None, // unbounded
            };
        loop {
            self.process_deposit_queue().await;
            let deposits_res = self
                .provider
                .rest()
                .get_deposits(
                    &self.provider.escrow_address().to_string(),
                    lower_bound_unix_time,
                )
                .await;
            let deposits = match deposits_res {
                Ok(deposits) => deposits,
                Err(e) => {
                    warn!(error = ?e, "Dymension, query new Kaspa deposits failed");
                    time::sleep(self.config.poll_interval()).await;
                    continue;
                }
            };
            // TODO: len include deposits that have been processed, the number is misleading
            info!(
                deposit_count = deposits.len(),
                "Dymension, queried kaspa deposits"
            );
            self.handle_new_deposits(deposits).await;

            time::sleep(self.config.poll_interval()).await;
        }
    }

    async fn handle_new_deposits(&self, deposits: Vec<Deposit>) {
        let mut deposits_new = Vec::new();
        let escrow_address = self.provider.escrow_address().to_string();

        for d in deposits.into_iter() {
            if !self.deposit_cache.has_seen(&d).await {
                // always mark as seen
                self.deposit_cache.mark_as_seen(d.clone()).await;
                // Check if this is actually a withdrawal by looking at transaction inputs
                match self.is_genuine_deposit(&d, &escrow_address).await {
                    // valid deposit. queue for processing
                    Ok(true) => {
                        info!(deposit = ?d, "Dymension, new deposit seen");
                        deposits_new.push(d);
                    }
                    // not a deposit, skip
                    Ok(false) => {
                        info!(deposit_id = %d.id, "Dymension, skipping deposit with invalid or missing Hyperlane payload");
                    }
                    // error checking deposit, skip but log
                    Err(e) => {
                        error!(deposit_id = %d.id, error = ?e, "Dymension, failed to check if deposit is genuine, skipping");
                    }
                }
            }
        }

        if !deposits_new.is_empty() {
            // Update balance metrics periodically
            if let Err(e) = self.provider.update_balance_metrics().await {
                error!("Failed to update balance metrics: {:?}", e);
            }
        }

        for d in &deposits_new {
            let operation =
                DepositOperation::new(d.clone(), self.provider.escrow_address().to_string());
            self.process_deposit_operation(operation).await;
        }
    }

    /// Check if a deposit is genuine by validating the payload contains a valid Hyperlane message
    /// Returns true if it's a genuine deposit with valid Hyperlane payload, false otherwise
    async fn is_genuine_deposit(&self, deposit: &Deposit, _escrow_address: &str) -> Result<bool> {
        use dym_kas_core::message::ParsedHL;

        // Check if deposit has a payload
        let payload = match &deposit.payload {
            Some(payload) => payload,
            None => {
                info!(deposit_id = %deposit.id, "Deposit has no payload, skipping");
                return Ok(false);
            }
        };

        // Try to parse the payload as a Hyperlane message
        match ParsedHL::parse_string(payload) {
            Ok(parsed_hl) => {
                info!(
                    deposit_id = %deposit.id,
                    message_id = ?parsed_hl.hl_message.id(),
                    "Valid Hyperlane message found in deposit payload"
                );
                Ok(true) // Valid Hyperlane message, genuine deposit
            }
            Err(e) => {
                info!(
                    deposit_id = %deposit.id,
                    error = ?e,
                    "Invalid Hyperlane payload, skipping deposit"
                );
                Ok(false) // Invalid payload, not a genuine Hyperlane deposit
            }
        }
    }

    /// Process the retry queue for failed deposit operations
    async fn process_deposit_queue(&self) {
        let mut queue = self.deposit_queue.lock().await;

        while let Some(operation) = queue.pop_ready() {
            drop(queue); // Release lock before processing
            self.process_deposit_operation(operation).await;
            queue = self.deposit_queue.lock().await;
        }
    }

    /// Process a single deposit operation, with retry logic on failure
    async fn process_deposit_operation(&self, mut operation: DepositOperation) {
        info!(deposit_id = %operation.deposit.id, "Processing deposit operation");

        // Use the operation creation time for accurate end-to-end latency measurement
        let operation_start_time = operation.created_at;

        // Calculate deposit amount early (for metrics in case of failure)
        let deposit_amount = if let Some(payload) = &operation.deposit.payload {
            match dym_kas_core::message::ParsedHL::parse_string(payload) {
                Ok(parsed_hl) => parsed_hl.token_message.amount().low_u64(),
                Err(e) => {
                    tracing::warn!(
                        "Failed to parse deposit payload for amount, using 0: {:?}",
                        e
                    );
                    0
                }
            }
        } else {
            tracing::warn!("Deposit has no payload, using 0 for amount");
            0
        };

        let new_deposit_res = relayer_on_new_deposit(
            &operation.escrow_address,
            &operation.deposit,
            &self.provider.rest().client.client,
        )
        .await;

        match new_deposit_res {
            Ok(Some(fxg)) => {
                info!(fxg = ?fxg, "Dymension, built new deposit FXG");

                let delivered_res = self.hub_mailbox.delivered(fxg.hl_message.id()).await;
                match delivered_res {
                    Ok(true) => {
                        info!(
                            message_id = ?fxg.hl_message.id(),
                            "Dymension, deposit already delivered, skipping"
                        );
                        return; // Successfully processed (already delivered)
                    }
                    Err(e) => {
                        error!(error = ?e, "Dymension, check if deposit is delivered");
                        // Record failed deposit attempt with deduplication
                        let deposit_id = format!("{:?}", operation.deposit.id);
                        self.provider
                            .metrics()
                            .record_deposit_failed(&deposit_id, deposit_amount);
                        // This is a transient error, queue for retry
                        operation.mark_failed(&self.config);
                        self.deposit_queue.lock().await.requeue(operation);
                        return;
                    }
                    _ => {} // Not delivered, continue processing
                };

                // Send to hub
                let res = self.get_deposit_validator_sigs_and_send_to_hub(&fxg).await;
                match res {
                    Ok(_) => {
                        info!(fxg = ?fxg, "Dymension, got sigs and sent new deposit to hub");

                        // Calculate end-to-end processing latency from initial detection to hub confirmation
                        let latency_ms = operation_start_time.elapsed().as_millis() as i64;

                        // Record successful deposit processing with amount and latency
                        let deposit_amount = fxg.amount.low_u64(); // Convert U256 to u64 for metrics
                        let deposit_id = format!("{:?}", operation.deposit.id);
                        self.provider
                            .metrics()
                            .record_deposit_processed(&deposit_id, deposit_amount);
                        self.provider.metrics().update_deposit_latency(latency_ms);

                        // Success! Operation complete
                        operation.reset_attempts();
                    }
                    Err(e) => {
                        let kaspa_err = self.chain_error_to_kaspa_error(&e);
                        if kaspa_err.is_retryable() {
                            error!(
                                error = ?e,
                                "Dymension, gather sigs and send deposit to hub (retryable)"
                            );
                            // Record failed deposit attempt with deduplication
                            let deposit_id = format!("{:?}", operation.deposit.id);
                            self.provider
                                .metrics()
                                .record_deposit_failed(&deposit_id, deposit_amount);
                            // Retryable error, queue for retry
                            operation.mark_failed(&self.config);
                            self.deposit_queue.lock().await.requeue(operation);
                        } else {
                            error!(
                                error = ?e,
                                "Dymension, gather sigs and send deposit to hub (non-retryable)"
                            );
                            // Record failed deposit attempt with deduplication
                            let deposit_id = format!("{:?}", operation.deposit.id);
                            self.provider
                                .metrics()
                                .record_deposit_failed(&deposit_id, deposit_amount);
                            // Non-retryable error, drop the operation
                            info!(
                                deposit_id = %operation.deposit.id,
                                "Dropping operation due to non-retryable error"
                            );
                        }
                    }
                }
            }
            Ok(None) => {
                info!("Dymension, F() new deposit returned none, will retry");
                // Record failed deposit attempt with deduplication
                let deposit_id = format!("{:?}", operation.deposit.id);
                self.provider
                    .metrics()
                    .record_deposit_failed(&deposit_id, deposit_amount);
                // This could be transient, queue for retry
                operation.mark_failed(&self.config);
                self.deposit_queue.lock().await.requeue(operation);
            }
            Err(e) => {
                // Convert relayer error to our error type
                let kaspa_err = KaspaDepositError::from(e);

                // Record failed deposit attempt with deduplication
                let deposit_id = format!("{:?}", operation.deposit.id);
                self.provider
                    .metrics()
                    .record_deposit_failed(&deposit_id, deposit_amount);

                if let Some(retry_delay_secs) = kaspa_err.retry_delay_hint() {
                    // Use the calculated retry delay based on pending confirmations
                    let delay = Duration::from_secs_f64(retry_delay_secs);
                    operation.mark_failed_with_custom_delay(delay, &kaspa_err.to_string());
                } else {
                    // Use standard exponential backoff for processing errors
                    error!(
                        error = ?kaspa_err,
                        "Dymension, F() new deposit processing error, will retry"
                    );
                    operation.mark_failed(&self.config);
                }
                self.deposit_queue.lock().await.requeue(operation);
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

            // we wait for finality time before sending to hub in case there is a confirmation pending, but without consuming first to be able to detect pending confirmations in withdrawal flow

            let confirmation = self.provider.get_pending_confirmation().await;

            match confirmation {
                Some(confirmation) => {
                    let res = self.confirm_withdrawal_on_hub(confirmation.clone()).await;
                    match res {
                        Ok(_) => {
                            info!(confirmation = ?confirmation, "Dymension, confirmed withdrawal on hub");
                            // Clear pending confirmations on success
                            self.provider.metrics().update_confirmations_pending(0);
                            self.provider.consume_pending_confirmation();

                            // Update hub anchor point metric after successful confirmation
                            if let Err(e) = self.update_hub_anchor_point_metric().await {
                                warn!(error = ?e, "Failed to update hub anchor point metric after successful confirmation");
                            }
                        }
                        Err(KaspaTxError::NotFinalError {
                            retry_after_secs, ..
                        }) => {
                            info!(
                                retry_after_secs = retry_after_secs,
                                "Dymension, withdrawal not final yet, sleeping before retry"
                            );
                            // Update pending confirmations count
                            self.provider.metrics().update_confirmations_pending(1);
                            time::sleep(Duration::from_secs_f64(retry_after_secs)).await;
                            continue; // Retry after waiting
                        }
                        Err(e) => {
                            error!("Dymension, confirm withdrawal on hub: {:?}", e);
                            // Record confirmation failure
                            self.provider.metrics().record_confirmation_failed();
                        }
                    }
                }
                None => {
                    info!("Dymension, no pending confirmation found.");
                }
            }

            time::sleep(self.config.poll_interval()).await;
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

    /// Convert chain communication error to Kaspa error
    fn chain_error_to_kaspa_error(&self, error: &ChainCommunicationError) -> KaspaDepositError {
        // Just return a processing error - we shouldn't try to parse error strings
        KaspaDepositError::ProcessingError(error.to_string())
    }

    /// TODO: unused for now because we skirt the usual DB management
    /// if bringing back, see https://github.com/dymensionxyz/hyperlane-monorepo/blob/093dba37d696acc0c4440226c68f80dc85e42ce6/rust/main/hyperlane-base/src/kas_hack/logic_loop.rs#L92-L94
    async fn _deposits_to_logs<T>(&self, _deposits: Vec<Deposit>) -> Vec<(Indexed<T>, LogMeta)>
    where
        T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
    {
        unimplemented!()
    }

    /// TODO: unused for now because we skirt the usual DB management
    async fn _dedupe_and_store_logs<T, S>(
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
            debug!(error = ?err, "Error storing logs in db");
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

        // get all utxos from kaspa for the escrow address
        let escrow_address = self.provider.escrow_address();

        info!(
            "Dymension, current anchor: {:?}, escrow address: {:?}",
            old_anchor, escrow_address
        );

        let all_escrow_utxos = self
            .provider
            .rpc()
            .get_utxos_by_addresses(vec![escrow_address.clone()])
            .await?;

        info!(
            "Queried utxos for escrow address: {:?}",
            all_escrow_utxos.len()
        );

        // check if the anchor utxo is in the utxos.
        // if it found, it's means we're synced.
        let hub_is_synced = all_escrow_utxos.iter().any(|utxo| {
            let ok = utxo.outpoint.transaction_id == old_anchor.transaction_id
                && utxo.outpoint.index == old_anchor.index;
            if ok {
                info!(utxo = ?utxo, "Dymension, found utxo matching current anchor");
            }
            ok
        });
        if !hub_is_synced {
            info!("Dymension is not synced, preparing progress indication and submitting to hub");
            // we need to iterate over the utxos and find the next utxo of the escrow address

            let mut good = false;
            for utxo in all_escrow_utxos {
                let new_anchor_candidate = TransactionOutpoint::from(utxo.outpoint);
                let fxg = expensive_trace_transactions(
                    &self.provider.rest().client.client,
                    &escrow_address.to_string(),
                    new_anchor_candidate.clone(),
                    old_anchor,
                )
                .await;
                if !fxg.is_ok() {
                    error!(
                        "Dymension, invalid confirmation candidate: error tracing sequence of kaspa withdrawals for syncing: {:?}, candidate: {:?}",
                        fxg.err(),
                        new_anchor_candidate,
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

        // Update hub anchor point metric after syncing (in all cases)
        if let Err(e) = self.update_hub_anchor_point_metric().await {
            warn!(error = ?e, "Failed to update hub anchor point metric after syncing");
        }

        Ok(())
    }

    /// Update hub anchor point metric by querying the current hub state
    async fn update_hub_anchor_point_metric(&self) -> Result<()> {
        // Query current anchor point from hub
        let resp = self.hub_mailbox.provider().grpc().outpoint(None).await?;

        if let Some(outpoint) = resp.outpoint {
            let tx_id = kaspa_hashes::Hash::from_bytes(
                outpoint
                    .transaction_id
                    .as_slice()
                    .try_into()
                    .map_err(|e| eyre::eyre!("Invalid transaction ID bytes: {:?}", e))?,
            );
            let current_timestamp = kaspa_core::time::unix_now();

            // Update the metric (using outpoint index as a proxy for processing info)
            self.provider.metrics().update_hub_anchor_point(
                &tx_id.to_string(),
                outpoint.index as u64,
                current_timestamp,
            );

            info!(
                tx_id = %tx_id,
                outpoint_index = outpoint.index,
                "Updated hub anchor point metric"
            );
        } else {
            warn!("No anchor point found in hub response");
        }

        Ok(())
    }

    /// Handle sync requirement by preparing progress indication and submitting to hub
    /// needs to satisfy
    /// https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/keeper/msg_server.go#L42-L48
    /// https://github.com/dymensionxyz/dymension/blob/2ddaf251568713d45a6900c0abb8a30158efc9aa/x/kas/types/d.go#L76-L84
    async fn confirm_withdrawal_on_hub(&self, fxg: ConfirmationFXG) -> Result<(), KaspaTxError> {
        // Check finality status before confirming withdrawal
        // Use the last outpoint (new anchor) from the sequence
        let new_anchor = fxg.outpoints.last().ok_or_else(|| {
            KaspaTxError::ProcessingError(eyre::eyre!("No outpoints in confirmation FXG"))
        })?;

        let finality_status = is_safe_against_reorg(
            &self.provider.rest().client.client,
            &new_anchor.transaction_id.to_string(),
            None,
        )
        .await
        .map_err(|e| KaspaTxError::ProcessingError(e))?;

        if !finality_status.is_final() {
            return Err(KaspaTxError::NotFinalError {
                confirmations: finality_status.confirmations,
                required_confirmations: finality_status.required_confirmations,
                retry_after_secs: (finality_status.required_confirmations
                    - finality_status.confirmations) as f64
                    * 0.1,
            });
        }

        info!(
            confirmations = finality_status.confirmations,
            required = finality_status.required_confirmations,
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
        let formatted_sigs = self
            .format_ad_hoc_signatures(
                &mut sigs,
                self.provider.validators().multisig_threshold_hub_ism() as usize,
            )
            .map_err(|e| {
                KaspaTxError::ProcessingError(eyre::eyre!("Failed to format signatures: {}", e))
            })?;

        info!(
            "Dymension, formatted confirmation sigs: {:?}",
            formatted_sigs
        );

        let outcome = self
            .hub_mailbox
            .indicate_progress(&formatted_sigs, &fxg.progress_indication)
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
