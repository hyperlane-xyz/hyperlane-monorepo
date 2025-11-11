use crate::contract_sync::cursors::Indexable;
use dym_kas_core::message::add_kaspa_metadata_hl_messsage;
use dym_kas_core::{
    confirmation::ConfirmationFXG, deposit::DepositFXG, finality::is_safe_against_reorg,
};
use dym_kas_relayer::confirm::expensive_trace_transactions;
use dym_kas_relayer::deposit::{on_new_deposit as relayer_on_new_deposit, KaspaTxError};
use dymension_kaspa::{Deposit, KaspaProvider};
use ethers::utils::hex::ToHex;
use eyre::Result;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, CheckpointWithMessageId, HyperlaneChain,
    HyperlaneLogStore, Indexed, LogMeta, Mailbox, MultisigSignedCheckpoint, Signature,
    SignedCheckpointWithMessageId, TxOutcome, H256, U256,
};
use hyperlane_cosmos::native::{h512_to_cosmos_hash, CosmosNativeMailbox};
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_core::time::unix_now;
use std::{collections::HashSet, fmt::Debug, hash::Hash, sync::Arc, time::Duration};
use tokio::{sync::Mutex, task::JoinHandle, time};
use tokio_metrics::TaskMonitor;
use tracing::{debug, error, info, info_span, Instrument};

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
            .kaspa_time_cfg()
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
        let lower_bound_unix_time: Option<i64> =
            match self.provider.must_relayer_stuff().deposit_look_back_mins {
                Some(offset) => {
                    let secs = offset * 60;
                    let dur = Duration::new(secs, 0);
                    Some(unix_now() as i64 - dur.as_millis() as i64)
                }
                None => None,
            };
        loop {
            self.process_deposit_queue().await;
            let result = self
                .provider
                .rest()
                .get_deposits(
                    &self.provider.escrow_address().to_string(),
                    lower_bound_unix_time,
                )
                .await;
            let deposits = match result {
                Ok(deposits) => deposits,
                Err(e) => {
                    error!(error = ?e, "Dymension, query new Kaspa deposits failed");
                    time::sleep(self.config.poll_interval()).await;
                    continue;
                }
            };
            info!(
                deposit_count = deposits.len(),
                "Dymension, queried kaspa deposits"
            );
            self.handle_new_deposits(deposits).await;

            time::sleep(self.config.poll_interval()).await;
        }
    }

    async fn handle_new_deposits(&self, deposits: Vec<Deposit>) {
        let mut new_deposits = Vec::new();
        let escrow_address = self.provider.escrow_address().to_string();

        for dep in deposits.into_iter() {
            if !self.deposit_cache.has_seen(&dep).await {
                self.deposit_cache.mark_as_seen(dep.clone()).await;
                match self.is_deposit(&dep, &escrow_address).await {
                    Ok(true) => {
                        info!(deposit = ?dep, "Dymension, new deposit seen");
                        new_deposits.push(dep);
                    }
                    Ok(false) => {
                        info!(deposit_id = %dep.id, "Dymension, skipping deposit with invalid or missing Hyperlane payload");
                    }
                    Err(e) => {
                        error!(deposit_id = %dep.id, error = ?e, "Dymension, failed to check if deposit is genuine, skipping");
                    }
                }
            }
        }

        if !new_deposits.is_empty() {
            if let Err(e) = self.provider.update_balance_metrics().await {
                error!("Failed to update balance metrics: {:?}", e);
            }
        }

        for dep in &new_deposits {
            let op = DepositOperation::new(dep.clone(), self.provider.escrow_address().to_string());
            self.process_deposit_operation(op).await;
        }
    }

    async fn is_deposit(&self, deposit: &Deposit, _escrow_address: &str) -> Result<bool> {
        use dym_kas_core::message::ParsedHL;

        let payload = match &deposit.payload {
            Some(payload) => payload,
            None => {
                info!(deposit_id = %deposit.id, "Deposit has no payload, skipping");
                return Ok(false);
            }
        };

        match ParsedHL::parse_string(payload) {
            Ok(parsed_hl) => {
                info!(
                    deposit_id = %deposit.id,
                    message_id = ?parsed_hl.hl_message.id(),
                    "Valid Hyperlane message found in deposit payload"
                );
                Ok(true)
            }
            Err(e) => {
                info!(
                    deposit_id = %deposit.id,
                    error = ?e,
                    "Invalid Hyperlane payload, skipping deposit"
                );
                Ok(false)
            }
        }
    }

    /// Process the retry queue for failed deposit operations
    async fn process_deposit_queue(&self) {
        let mut q = self.deposit_queue.lock().await;

        while let Some(op) = q.pop_ready() {
            drop(q);
            self.process_deposit_operation(op).await;
            q = self.deposit_queue.lock().await;
        }
    }

    /// Decode deposit payload into Hyperlane message with Kaspa metadata
    fn decode_and_add_kaspa_metadata(
        &self,
        deposit: &Deposit,
        escrow_address: &str,
    ) -> Result<(hyperlane_core::HyperlaneMessage, u64, usize), eyre::Error> {
        use dym_kas_core::message::ParsedHL;

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

    async fn process_deposit_operation(&self, mut op: DepositOperation) {
        info!(deposit_id = %op.deposit.id, "Processing deposit operation");

        let start_time = op.created_at;

        // Decode payload and add Kaspa metadata to get the proper HL message
        let (hl_message, amount, utxo_index) =
            match self.decode_and_add_kaspa_metadata(&op.deposit, &op.escrow_address) {
                Ok((msg, amt, idx)) => {
                    // Store deposit hl message with Kaspa metadata in database
                    self.provider
                        .store_deposit(&msg, &op.deposit.id.to_string());
                    (msg, amt, idx)
                }
                Err(e) => {
                    tracing::error!(
                        deposit_id = %op.deposit.id,
                        error = ?e,
                        "Failed to decode deposit payload and add Kaspa metadata"
                    );
                    let deposit_id = format!("{:?}", op.deposit.id);
                    self.provider
                        .metrics()
                        .record_deposit_failed(&deposit_id, 0);
                    return;
                }
            };

        let result = relayer_on_new_deposit(
            hl_message.clone(),
            U256::from(amount),
            utxo_index,
            &op.deposit,
            &self.provider.rest().client.client,
        )
        .await;

        match result {
            Ok(Some(fxg)) => {
                info!(fxg = ?fxg, "Dymension, built new deposit FXG");

                let result = self.hub_mailbox.delivered(fxg.hl_message.id()).await;
                match result {
                    Ok(true) => {
                        info!(
                            message_id = ?fxg.hl_message.id(),
                            "Dymension, deposit already delivered, skipping"
                        );
                        return;
                    }
                    Err(e) => {
                        error!(error = ?e, "Dymension, check if deposit is delivered");
                        let deposit_id = format!("{:?}", op.deposit.id);
                        self.provider
                            .metrics()
                            .record_deposit_failed(&deposit_id, amount);
                        op.mark_failed(&self.config);
                        self.deposit_queue.lock().await.requeue(op);
                        return;
                    }
                    _ => {}
                };

                let result = self.get_deposit_validator_sigs_and_send_to_hub(&fxg).await;
                match result {
                    Ok(outcome) => {
                        let tx_hash =
                            hyperlane_cosmos::native::h512_to_cosmos_hash(outcome.transaction_id)
                                .encode_hex_upper::<String>();
                        let amount = fxg.amount.low_u64();
                        let deposit_id = format!("{:?}", op.deposit.id);

                        // Update the stored deposit with new HyperlaneMessage and Hub transaction ID
                        let h256_hub_tx =
                            hyperlane_cosmos::native::h512_to_h256(outcome.transaction_id);
                        self.provider.update_processed_deposit(
                            &op.deposit.id.to_string(),
                            fxg.hl_message.clone(),
                            &h256_hub_tx,
                        );

                        if !outcome.executed {
                            error!(
                                message_id = ?fxg.hl_message.id(),
                                tx_hash = %tx_hash,
                                gas_used = %outcome.gas_used,
                                "Dymension, deposit process() failed - TX was not executed on-chain"
                            );

                            self.provider
                                .metrics()
                                .record_deposit_failed(&deposit_id, amount);

                            op.mark_failed(&self.config);
                            self.deposit_queue.lock().await.requeue(op);
                        } else {
                            info!(
                                fxg = ?fxg,
                                tx_hash = %tx_hash,
                                "Dymension, got sigs and sent new deposit to hub"
                            );

                            let latency_ms = start_time.elapsed().as_millis() as i64;

                            self.provider
                                .metrics()
                                .record_deposit_processed(&deposit_id, amount);
                            self.provider.metrics().update_deposit_latency(latency_ms);

                            op.reset_attempts();
                        }
                    }
                    Err(e) => {
                        let kaspa_err = self.chain_error_to_kaspa_error(&e);
                        if kaspa_err.is_retryable() {
                            error!(
                                error = ?e,
                                "Dymension, gather sigs and send deposit to hub (retryable)"
                            );
                            let deposit_id = format!("{:?}", op.deposit.id);
                            self.provider
                                .metrics()
                                .record_deposit_failed(&deposit_id, amount);
                            op.mark_failed(&self.config);
                            self.deposit_queue.lock().await.requeue(op);
                        } else {
                            error!(
                                error = ?e,
                                "Dymension, gather sigs and send deposit to hub (non-retryable)"
                            );
                            let deposit_id = format!("{:?}", op.deposit.id);
                            self.provider
                                .metrics()
                                .record_deposit_failed(&deposit_id, amount);
                            info!(
                                deposit_id = %op.deposit.id,
                                "Dropping operation due to non-retryable error"
                            );
                        }
                    }
                }
            }
            Ok(None) => {
                info!("Dymension, F() new deposit returned none, will retry");
                let deposit_id = format!("{:?}", op.deposit.id);
                self.provider
                    .metrics()
                    .record_deposit_failed(&deposit_id, amount);
                op.mark_failed(&self.config);
                self.deposit_queue.lock().await.requeue(op);
            }
            Err(e) => {
                let kaspa_err = KaspaDepositError::from(e);

                let deposit_id = format!("{:?}", op.deposit.id);
                self.provider
                    .metrics()
                    .record_deposit_failed(&deposit_id, amount);

                if let Some(retry_delay_secs) = kaspa_err.retry_delay_hint() {
                    let delay = Duration::from_secs_f64(retry_delay_secs);
                    op.mark_failed_with_custom_delay(delay, &kaspa_err.to_string());
                } else {
                    error!(
                        error = ?kaspa_err,
                        "Dymension, F() new deposit processing error, will retry"
                    );
                    op.mark_failed(&self.config);
                }
                self.deposit_queue.lock().await.requeue(op);
            }
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

            time::sleep(self.config.poll_interval()).await;
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
        info!("Checking if hub is out of sync with Kaspa escrow account.");
        use hyperlane_cosmos::{native::ModuleQueryClient, CosmosProvider};
        let prov = self.hub_mailbox.provider();
        let cosmos_prov = prov
            .as_any()
            .downcast_ref::<CosmosProvider<ModuleQueryClient>>()
            .expect("Hub mailbox provider must be CosmosProvider");
        let resp = cosmos_prov.query().outpoint(None).await?;
        let anchor_old = resp
            .outpoint
            .map(|o| TransactionOutpoint {
                transaction_id: kaspa_hashes::Hash::from_bytes(
                    o.transaction_id.as_slice().try_into().unwrap(),
                ),
                index: o.index,
            })
            .ok_or_else(|| eyre::eyre!("No outpoint found"))?;

        let escrow_addr = self.provider.escrow_address();

        info!(
            "Dymension, current anchor: {:?}, escrow address: {:?}",
            anchor_old, escrow_addr
        );

        let utxos = self
            .provider
            .rpc()
            .get_utxos_by_addresses(vec![escrow_addr.clone()])
            .await?;

        info!("Queried utxos for escrow address: {:?}", utxos.len());

        // Check if anchor UTXO exists in current escrow UTXOs - if yes, we're synced
        let synced = utxos.iter().any(|utxo| {
            let ok = utxo.outpoint.transaction_id == anchor_old.transaction_id
                && utxo.outpoint.index == anchor_old.index;
            if ok {
                info!(utxo = ?utxo, "Dymension, found utxo matching current anchor");
            }
            ok
        });
        if !synced {
            info!("Dymension is not synced, preparing progress indication and submitting to hub");
            // Find the next UTXO in sequence by tracing from anchor_old to each candidate
            let mut found = false;
            for utxo in utxos {
                let candidate = TransactionOutpoint::from(utxo.outpoint);
                let result = expensive_trace_transactions(
                    &self.provider.rest().client.client,
                    &escrow_addr.to_string(),
                    candidate.clone(),
                    anchor_old,
                )
                .await;
                if !result.is_ok() {
                    error!(
                        "Dymension, tracing kaspa withdrawals for syncing: {:?}, candidate: {:?}",
                        result.err(),
                        candidate,
                    );
                    continue;
                }
                info!("Traced sequence of kaspa withdrawals for syncing");

                self.confirm_withdrawal_on_hub(result.unwrap()).await?;
                found = true;
                break;
            }
            if !found {
                return Err(eyre::eyre!("Dymension, no good utxo found for syncing"));
            }
        }
        info!("Dymension hub is synced, proceeding with other tasks");

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

    // TODO: can probably just use the ad hoc method
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

pub struct DepositCache {
    seen: Mutex<HashSet<Deposit>>,
}

impl DepositCache {
    pub fn new() -> Self {
        Self {
            seen: Mutex::new(HashSet::new()),
        }
    }

    async fn has_seen(&self, dep: &Deposit) -> bool {
        let guard = self.seen.lock().await;
        guard.contains(dep)
    }

    async fn mark_as_seen(&self, dep: Deposit) {
        let mut guard = self.seen.lock().await;
        guard.insert(dep);
    }
}

pub trait MetadataConstructor {
    fn metadata(&self, ckpt: &MultisigSignedCheckpoint) -> Result<Vec<u8>>;
}
