use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::ops::Mul;
use std::sync::Arc;
use std::time::Duration;

use derive_new::new;
use eyre::{eyre, Result};
use futures_util::future::try_join_all;
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

pub type InclusionStagePool = Arc<Mutex<HashMap<TransactionUuid, Transaction>>>;

pub const STAGE_NAME: &str = "InclusionStage";

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

    async fn receive_txs(
        mut building_stage_receiver: mpsc::Receiver<Transaction>,
        pool: InclusionStagePool,
        state: DispatcherState,
        domain: String,
    ) -> Result<(), LanderError> {
        loop {
            state
                .metrics
                .update_liveness_metric(format!("{}::receive_txs", STAGE_NAME).as_str(), &domain);
            if let Some(tx) = building_stage_receiver.recv().await {
                // the lock is held until the metric is updated to prevent race conditions
                let mut pool_lock = pool.lock().await;
                let pool_len = pool_lock.len();
                pool_lock.insert(tx.uuid.clone(), tx.clone());
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

    async fn process_txs(
        pool: InclusionStagePool,
        finality_stage_sender: mpsc::Sender<Transaction>,
        state: DispatcherState,
        domain: String,
    ) -> Result<(), LanderError> {
        let estimated_block_time = state.adapter.estimated_block_time();

        // minimum sleep duration to avoid busy waiting
        const MIN_SLEEP_DURATION: Duration = Duration::from_millis(100);

        // number of attempts done before a new finalized block is observed
        let mut attempt_count = 0;

        // initial sleep duration is set to the estimated block time, otherwise
        // it will be calculated dynamically based on the attempt count
        let mut sleep_duration = *estimated_block_time;

        // evaluate the pool every block
        loop {
            // sleep for the estimated block time or with exponential backoff
            sleep(sleep_duration).await;

            let before_processing = tokio::time::Instant::now();
            let new_block_finalized = state.adapter.new_block_finalized().await?;

            sleep_duration = if new_block_finalized {
                Self::process_txs_step(&pool, &finality_stage_sender, &state, &domain).await?;

                // reset the attempt count since a new block was finalized
                attempt_count = 0;

                // we expect the next block to be finalized in the estimated block time minus
                // the time we spent processing
                *estimated_block_time - before_processing.elapsed()
            } else {
                // increment the attempt count since we waited for a now block to be finalized,
                // but it didn't happen, so we will try again as soon as possible, but with
                // an exponential backoff
                attempt_count += 1;

                // we calculate exponential backoff duration based on the attempt count
                // backoff = MIN_SLEEP_DURATION * 2^attempt_count
                let backoff_duration = MIN_SLEEP_DURATION
                    .checked_mul(1 << attempt_count)
                    .unwrap_or(*estimated_block_time);

                // if backoff duration exceeds the estimated block time, we sleep only for
                // the estimated block time to avoid long delays
                std::cmp::min(backoff_duration, *estimated_block_time)
            }
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
            .update_liveness_metric(format!("{}::process_txs", STAGE_NAME).as_str(), domain);

        let pool_snapshot = {
            let pool_snapshot = pool.lock().await.clone();
            state.metrics.update_queue_length_metric(
                STAGE_NAME,
                pool_snapshot.len() as u64,
                domain,
            );
            pool_snapshot
        };
        info!(pool_size=?pool_snapshot.len() , "Processing transactions in inclusion pool");
        for (_, mut tx) in pool_snapshot {
            if let Err(err) =
                Self::try_process_tx(tx.clone(), finality_stage_sender, state, pool).await
            {
                error!(?err, ?tx, "Error processing transaction. Dropping it");
                Self::drop_tx(state, &mut tx, TxDropReason::FailedSimulation, pool).await?;
            }
        }
        Ok(())
    }

    #[instrument(
        skip_all,
        name = "InclusionStage::try_process_tx",
        fields(tx_uuid = ?tx.uuid, tx_status = ?tx.status, payloads = ?tx.payload_details)
    )]
    async fn try_process_tx(
        tx: Transaction,
        finality_stage_sender: &mpsc::Sender<Transaction>,
        state: &DispatcherState,
        pool: &InclusionStagePool,
    ) -> Result<()> {
        info!(?tx, "Processing inclusion stage transaction");
        let tx_status = call_until_success_or_nonretryable_error(
            || state.adapter.tx_status(&tx),
            "Querying transaction status",
            state,
        )
        .await?;
        info!(?tx, next_tx_status = ?tx_status, "Transaction status");

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
    ) -> Result<()> {
        match tx_status {
            TransactionStatus::PendingInclusion | TransactionStatus::Mempool => {
                info!(tx_uuid = ?tx.uuid, ?tx_status, "Transaction is pending inclusion");
                if !state.adapter.tx_ready_for_resubmission(&tx).await {
                    info!(?tx, "Transaction is not ready for resubmission");
                    return Ok(());
                }
                Self::process_pending_tx(tx, state, pool).await
            }
            TransactionStatus::Included | TransactionStatus::Finalized => {
                update_tx_status(state, &mut tx, tx_status.clone()).await?;
                let tx_uuid = tx.uuid.clone();
                finality_stage_sender.send(tx).await?;
                info!(?tx_uuid, ?tx_status, "Transaction included in block");
                pool.lock().await.remove(&tx_uuid);
                Ok(())
            }
            TransactionStatus::Dropped(_) => {
                error!(
                    ?tx,
                    ?tx_status,
                    "Transaction has invalid status for inclusion stage"
                );
                Err(eyre!("Transaction has invalid status for inclusion stage"))
            }
        }
    }

    #[instrument(skip_all, name = "InclusionStage::process_pending_tx")]
    async fn process_pending_tx(
        mut tx: Transaction,
        state: &DispatcherState,
        pool: &InclusionStagePool,
    ) -> Result<()> {
        info!(?tx, "Processing pending transaction");

        // update tx submission attempts
        tx.submission_attempts += 1;

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

        // update the pool entry of this tx, to reflect any changes such as the gas price, hash, etc
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
                    state.adapter.submit(&mut tx_guard).await?;
                    Ok(tx_guard.clone())
                }
            },
            "Submitting transaction",
            state,
        )
        .await
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
}

#[cfg(test)]
pub mod tests;
