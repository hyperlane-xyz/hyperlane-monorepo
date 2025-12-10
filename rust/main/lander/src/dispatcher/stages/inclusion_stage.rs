use std::cmp::max;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use derive_new::new;
use eyre::{eyre, Result};
use futures_util::future::try_join_all;
use futures_util::try_join;
use tokio::sync::{mpsc, Mutex};
use tokio::time::sleep;
use tracing::{error, info, info_span, instrument, warn, Instrument};

use crate::{
    dispatcher::stages::utils::update_tx_status,
    error::LanderError,
    payload::{DropReason as PayloadDropReason, FullPayload, PayloadStatus},
    transaction::{DropReason as TxDropReason, Transaction, TransactionStatus, TransactionUuid},
};

use super::{utils::call_until_success_or_nonretryable_error, DispatcherState};

#[cfg(test)]
pub mod tests;

pub type InclusionStagePool = Arc<Mutex<HashMap<TransactionUuid, Transaction>>>;

pub const STAGE_NAME: &str = "InclusionStage";

const MIN_TX_STATUS_CHECK_DELAY: Duration = Duration::from_millis(100);

pub struct InclusionStage {
    pub(crate) pool: InclusionStagePool,
    tx_receiver: mpsc::Receiver<Transaction>,
    finality_stage_sender: mpsc::Sender<Transaction>,
    state: DispatcherState,
    domain: String,
}

impl InclusionStage {
    pub fn new(
        tx_receiver: mpsc::Receiver<Transaction>,
        finality_stage_sender: mpsc::Sender<Transaction>,
        state: DispatcherState,
        domain: String,
    ) -> Self {
        Self {
            pool: Arc::new(Mutex::new(HashMap::new())),
            tx_receiver,
            finality_stage_sender,
            state,
            domain,
        }
    }

    pub async fn run(self) {
        let InclusionStage {
            pool,
            tx_receiver,
            finality_stage_sender,
            state,
            domain,
        } = self;
        let futures = vec![
            tokio::spawn(
                Self::receive_reprocess_txs(domain.clone(), pool.clone(), state.clone())
                    .instrument(info_span!("receive_reprocess_txs")),
            ),
            tokio::spawn(
                Self::receive_txs(tx_receiver, pool.clone(), state.clone(), domain.clone())
                    .instrument(info_span!("receive_txs")),
            ),
            tokio::spawn(
                Self::process_txs(pool, finality_stage_sender, state, domain)
                    .instrument(info_span!("process_txs")),
            ),
        ];
        if let Err(err) = try_join_all(futures).await {
            error!(
                error=?err,
                "Inclusion stage future panicked"
            );
        }
    }

    #[instrument(skip_all, fields(domain))]
    pub async fn receive_txs(
        mut building_stage_receiver: mpsc::Receiver<Transaction>,
        pool: InclusionStagePool,
        state: DispatcherState,
        domain: String,
    ) -> Result<(), LanderError> {
        loop {
            state
                .metrics
                .update_liveness_metric(format!("{STAGE_NAME}::receive_txs").as_str(), &domain);
            if let Some(tx) = building_stage_receiver.recv().await {
                let pool_len = {
                    let mut pool_lock = pool.lock().await;
                    let pool_len = pool_lock.len();
                    pool_lock.insert(tx.uuid.clone(), tx.clone());
                    pool_len
                };
                info!(?tx, "Received transaction");
                state
                    .metrics
                    .update_queue_length_metric(STAGE_NAME, pool_len as u64, &domain);
            } else {
                error!("Building stage channel closed");
                return Err(LanderError::ChannelClosed);
            }
        }
    }

    #[instrument(skip_all, fields(domain))]
    async fn process_txs(
        pool: InclusionStagePool,
        finality_stage_sender: mpsc::Sender<Transaction>,
        state: DispatcherState,
        domain: String,
    ) -> Result<(), LanderError> {
        let base_interval = *state.adapter.estimated_block_time();
        // Use adaptive polling interval based on block time, but never faster than 100ms
        // for small block time chains, and never slower than 1/4 block time for responsiveness
        let polling_interval = max(
            base_interval.div_f64(4.0), // Never slower than 1/4 block time for responsiveness
            MIN_TX_STATUS_CHECK_DELAY,  // Never faster than 100ms to avoid excessive RPC calls
        );

        loop {
            sleep(polling_interval).await;
            Self::process_txs_step(&pool, &finality_stage_sender, &state, &domain).await?;
        }
    }

    pub async fn process_txs_step(
        pool: &InclusionStagePool,
        finality_stage_sender: &mpsc::Sender<Transaction>,
        state: &DispatcherState,
        domain: &str,
    ) -> Result<(), LanderError> {
        state
            .metrics
            .update_liveness_metric(format!("{STAGE_NAME}::process_txs").as_str(), domain);

        let pool_snapshot = {
            let pool_snapshot = pool.lock().await;
            let pool_snapshot = pool_snapshot.clone();
            state.metrics.update_queue_length_metric(
                STAGE_NAME,
                pool_snapshot.len() as u64,
                domain,
            );
            pool_snapshot
        };
        if pool_snapshot.is_empty() {
            return Ok(());
        }
        info!(pool_size=?pool_snapshot.len() , "Processing transactions in inclusion pool");

        let base_interval = *state.adapter.estimated_block_time();
        let now = chrono::Utc::now();

        for (_, mut tx) in pool_snapshot {
            // Update liveness metric on every tx as well.
            // This prevents alert misfires when there are many txs to process.
            state
                .metrics
                .update_liveness_metric(format!("{STAGE_NAME}::process_txs").as_str(), domain);

            if !Self::tx_ready_for_processing(base_interval, now, &tx) {
                continue;
            }

            if let Err(err) =
                Self::try_process_tx(tx.clone(), finality_stage_sender, state, pool).await
            {
                error!(?err, ?tx, "Error processing transaction. Dropping it");

                let drop_reason = match &err {
                    LanderError::TxDropped(reason) => reason.clone(),
                    _ => TxDropReason::FailedSimulation,
                };
                Self::drop_tx(state, &mut tx, drop_reason, pool).await?;
                Self::update_inclusion_stage_metric(state, domain, &err);
            }
        }
        Ok(())
    }

    #[instrument(skip_all, fields(domain))]
    pub async fn receive_reprocess_txs(
        domain: String,
        pool: InclusionStagePool,
        state: DispatcherState,
    ) -> Result<(), LanderError> {
        let poll_rate = match state.adapter.reprocess_txs_poll_rate() {
            Some(s) => s,
            // if no poll rate, then that means we don't worry about reprocessing txs
            None => return Ok(()),
        };
        loop {
            state.metrics.update_liveness_metric(
                format!("{STAGE_NAME}::receive_reprocess_txs").as_str(),
                &domain,
            );

            tokio::time::sleep(poll_rate).await;
            tracing::debug!(
                domain,
                "Checking for any transactions that needs reprocessing"
            );

            let txs = match state.adapter.get_reprocess_txs().await {
                Ok(s) => s,
                _ => continue,
            };
            if txs.is_empty() {
                continue;
            }

            tracing::debug!(?txs, "Reprocessing transactions");
            let mut locked_pool = pool.lock().await;
            for tx in txs {
                locked_pool.insert(tx.uuid.clone(), tx);
            }
        }
    }

    fn tx_ready_for_processing(
        base_interval: Duration,
        now: DateTime<Utc>,
        tx: &Transaction,
    ) -> bool {
        // Implement per-transaction backoff: don't check transactions too frequently
        if let Some(last_check) = tx.last_status_check {
            let time_since_last_check = now.signed_duration_since(last_check);

            // Calculate the backoff interval based on how long the transaction has been pending
            let tx_age = now.signed_duration_since(tx.creation_timestamp);
            let backoff_interval = if tx_age.num_seconds() < 30 {
                // New transactions: check every quarter of block time (responsive)
                // But for very new transactions (< 1 second), allow immediate recheck for testing
                if tx_age.num_seconds() < 1 {
                    Duration::ZERO // Immediate recheck for tests
                } else {
                    max(
                        base_interval.div_f64(4.0),
                        MIN_TX_STATUS_CHECK_DELAY.div_f64(4.0),
                    )
                }
            } else if tx_age.num_seconds() < 300 {
                // Medium age transactions: check every half of block time
                max(
                    base_interval.div_f64(2.0),
                    MIN_TX_STATUS_CHECK_DELAY.div_f64(2.0),
                )
            } else {
                // Old transactions: check every full block time
                max(base_interval, MIN_TX_STATUS_CHECK_DELAY)
            };

            // Skip this transaction if we checked it too recently
            if time_since_last_check
                .to_std()
                .unwrap_or(Duration::from_secs(0))
                < backoff_interval
            {
                return false;
            }
        }
        true
    }

    #[instrument(
        skip_all,
        name = "InclusionStage::try_process_tx",
        fields(tx_uuid = ?tx.uuid, tx_status = ?tx.status, payloads = ?tx.payload_details)
    )]
    async fn try_process_tx(
        mut tx: Transaction,
        finality_stage_sender: &mpsc::Sender<Transaction>,
        state: &DispatcherState,
        pool: &InclusionStagePool,
    ) -> Result<(), LanderError> {
        info!(?tx, "Processing inclusion stage transaction");

        // Update the last status check timestamp before querying
        tx.last_status_check = Some(chrono::Utc::now());

        let tx_status = call_until_success_or_nonretryable_error(
            || state.adapter.tx_status(&tx),
            "Querying transaction status",
            state,
        )
        .await?;
        info!(?tx, next_tx_status = ?tx_status, "Transaction status");

        // Update the transaction in the pool with the new timestamp
        {
            let mut pool_lock = pool.lock().await;
            pool_lock.insert(tx.uuid.clone(), tx.clone());
        }

        Self::try_process_tx_with_next_status(tx, tx_status, finality_stage_sender, state, pool)
            .await
    }

    #[instrument(
        skip_all,
        name = "InclusionStage::try_process_tx_with_next_status",
        fields(tx_uuid = ?tx.uuid, previous_tx_status = ?tx.status, next_tx_status = ?tx_status, payloads = ?tx.payload_details)
    )]
    async fn try_process_tx_with_next_status(
        mut tx: Transaction,
        tx_status: TransactionStatus,
        finality_stage_sender: &mpsc::Sender<Transaction>,
        state: &DispatcherState,
        pool: &InclusionStagePool,
    ) -> Result<(), LanderError> {
        match tx_status {
            TransactionStatus::PendingInclusion | TransactionStatus::Mempool => {
                info!(tx_uuid = ?tx.uuid, ?tx_status, "Transaction is pending inclusion");
                update_tx_status(state, &mut tx, tx_status.clone()).await?;
                if !state.adapter.tx_ready_for_resubmission(&tx).await {
                    info!(?tx, "Transaction is not ready for resubmission");
                    return Ok(());
                }
                Self::process_pending_tx(tx, state, pool).await
            }
            TransactionStatus::Included | TransactionStatus::Finalized => {
                update_tx_status(state, &mut tx, tx_status.clone()).await?;
                let tx_uuid = tx.uuid.clone();
                finality_stage_sender.send(tx).await.map_err(|err| {
                    tracing::error!(?err, "Failed to send tx to finality stage");
                    LanderError::ChannelSendFailure(Box::new(err))
                })?;
                info!(?tx_uuid, ?tx_status, "Transaction included in block");
                pool.lock().await.remove(&tx_uuid);
                Ok(())
            }
            TransactionStatus::Dropped(ref reason) => {
                error!(
                    ?tx,
                    ?tx_status,
                    "Transaction has invalid status for inclusion stage"
                );
                Err(LanderError::TxDropped(reason.clone()))
            }
        }
    }

    #[instrument(skip_all, name = "InclusionStage::process_pending_tx")]
    async fn process_pending_tx(
        mut tx: Transaction,
        state: &DispatcherState,
        pool: &InclusionStagePool,
    ) -> Result<(), LanderError> {
        info!(?tx, "Processing pending transaction");

        // update tx submission attempts
        tx.submission_attempts = tx.submission_attempts.saturating_add(1);
        tx.last_submission_attempt = Some(chrono::Utc::now());

        // Simulating transaction if it has never been submitted before
        tx = Self::simulate_tx(tx, state).await?;

        // Estimating transaction just before we submit it
        tx = Self::estimate_tx(&tx, state).await?;

        // Submitting transaction to the node
        tx = Self::submit_tx(&tx, state).await?;
        info!(?tx, "Transaction submitted to node");

        state
            .metrics
            .update_transaction_submissions_metric(&state.domain);
        state
            .adapter
            .update_vm_specific_metrics(&tx, &state.metrics);
        // update tx status in db
        update_tx_status(state, &mut tx, TransactionStatus::Mempool).await?;

        // update the pool entry of this tx, to reflect any changes such as
        // the gas price, hash, etc
        pool.lock().await.insert(tx.uuid.clone(), tx.clone());

        Ok(())
    }

    async fn submit_tx(
        tx: &Transaction,
        state: &DispatcherState,
    ) -> Result<Transaction, LanderError> {
        // create a temporary arcmutex so that submission retries are aware of tx fields (e.g. gas price)
        // set by previous retries when calling `adapter.submit`
        let tx_shared = Arc::new(Mutex::new(tx.clone()));
        // successively calling `submit` will result in escalating gas price until the tx is accepted
        // by the node.
        // at this point, not all VMs return information about whether the tx was reverted.
        // so dropping reverted payloads has to happen in the finality step
        call_until_success_or_nonretryable_error(
            || {
                let tx_shared_clone = tx_shared.clone();
                async move {
                    let mut tx_guard = tx_shared_clone.lock().await;
                    let submit_result = state.adapter.submit(&mut tx_guard).await;

                    match submit_result {
                        Ok(()) => Ok(tx_guard.clone()),
                        Err(err) if matches!(err, LanderError::TxAlreadyExists) => {
                            warn!(tx=?tx_guard, ?err, "Transaction resubmission failed, will check the status of transaction before dropping it");
                            Ok(tx_guard.clone())
                        }
                        Err(err) => Err(err),
                    }
                }
            },
            "Submitting transaction",
            state,
        ).await
    }

    async fn estimate_tx(
        tx: &Transaction,
        state: &DispatcherState,
    ) -> Result<Transaction, LanderError> {
        call_until_success_or_nonretryable_error(
            || {
                let tx_clone = tx.clone();
                async move {
                    let mut tx_clone_inner = tx_clone.clone();
                    state.adapter.estimate_tx(&mut tx_clone_inner).await?;
                    Ok(tx_clone_inner)
                }
            },
            "Estimating transaction",
            state,
        )
        .await
    }

    async fn simulate_tx(tx: Transaction, state: &DispatcherState) -> Result<Transaction> {
        if tx.submission_attempts > 1 {
            info!(
                ?tx,
                "Skipping simulation for transaction with submission attempts > 1"
            );
            return Ok(tx);
        }

        // simulate transaction if the transaction has not been submitted yet
        let (transaction, failed_payloads) = call_until_success_or_nonretryable_error(
            || {
                let tx_clone = tx.clone();
                async move {
                    let mut tx_clone_inner = tx_clone.clone();
                    let failed_payloads = state.adapter.simulate_tx(&mut tx_clone_inner).await?;
                    Ok((tx_clone_inner, failed_payloads))
                }
            },
            "Simulating transaction",
            state,
        )
        .await?;

        // drop failed payloads
        state
            .update_status_for_payloads(
                &failed_payloads,
                PayloadStatus::Dropped(PayloadDropReason::FailedSimulation),
            )
            .await;

        Ok(transaction)
    }

    async fn drop_tx(
        state: &DispatcherState,
        tx: &mut Transaction,
        reason: TxDropReason,
        pool: &InclusionStagePool,
    ) -> Result<()> {
        warn!(?tx, "Dropping tx");
        let new_tx_status = TransactionStatus::Dropped(reason);
        // this will drop the payloads as well
        update_tx_status(state, tx, new_tx_status.clone()).await?;
        pool.lock().await.remove(&tx.uuid);
        Ok(())
    }

    fn update_inclusion_stage_metric(state: &DispatcherState, domain: &str, err: &LanderError) {
        state.metrics.update_inclusion_stage_error_metric(
            domain,
            &err.to_metrics_label(),
            err.is_infra_error(),
        )
    }
}
