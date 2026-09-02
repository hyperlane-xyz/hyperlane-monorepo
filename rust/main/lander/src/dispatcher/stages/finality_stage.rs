use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};

use derive_new::new;
use eyre::{eyre, Result};
use futures_util::{future::try_join_all, StreamExt};
use tokio::{
    sync::{mpsc, Mutex},
    time::sleep,
};
use tracing::{error, info, info_span, instrument, warn, Instrument};

use crate::{
    dispatcher::stages::utils::update_tx_status,
    error::LanderError,
    payload::{DropReason as PayloadDropReason, FullPayload, PayloadStatus},
    transaction::{DropReason as TxDropReason, Transaction, TransactionStatus, TransactionUuid},
};

use super::{
    building_stage::BuildingStageQueue,
    utils::{
        buffer_ordered_bounded, call_until_success_or_nonretryable_error,
        read_transaction_status_batch, FinalizedStatusRead,
    },
    DispatcherState,
};

pub use pool::FinalityStagePool;

mod pool;

pub const STAGE_NAME: &str = "FinalityStage";
const STATUS_READ_CONCURRENCY: usize = 16;

pub struct FinalityStage {
    pub(crate) pool: FinalityStagePool,
    tx_receiver: mpsc::Receiver<Transaction>,
    building_stage_queue: BuildingStageQueue,
    state: DispatcherState,
    domain: String,
}

impl FinalityStage {
    pub fn new(
        tx_receiver: mpsc::Receiver<Transaction>,
        building_stage_queue: BuildingStageQueue,
        state: DispatcherState,
        domain: String,
    ) -> Self {
        Self {
            pool: FinalityStagePool::new(),
            tx_receiver,
            building_stage_queue,
            state,
            domain,
        }
    }

    pub async fn run(self) {
        let FinalityStage {
            pool,
            tx_receiver,
            building_stage_queue,
            state,
            domain,
        } = self;
        let futures = vec![
            tokio::spawn(
                Self::receive_txs(tx_receiver, pool.clone(), state.clone(), domain.clone())
                    .instrument(info_span!("receive_txs_task")),
            ),
            tokio::spawn(
                Self::process_txs(pool, building_stage_queue, state, domain)
                    .instrument(info_span!("process_txs_task")),
            ),
        ];
        if let Err(err) = try_join_all(futures).await {
            error!(
                error=?err,
                "Finality stage future panicked"
            );
        }
    }

    #[instrument(skip_all, fields(?domain))]
    async fn receive_txs(
        mut tx_receiver: mpsc::Receiver<Transaction>,
        pool: FinalityStagePool,
        state: DispatcherState,
        domain: String,
    ) -> Result<(), LanderError> {
        loop {
            state
                .metrics
                .update_liveness_metric(format!("{STAGE_NAME}::receive_txs").as_str(), &domain);
            if let Some(tx) = tx_receiver.recv().await {
                let _ = pool.insert(tx.clone()).await;
                info!(?tx, "Received transaction");
            } else {
                error!("Inclusion stage channel closed");
                return Err(LanderError::ChannelClosed);
            }
        }
    }

    #[instrument(skip_all, fields(?domain))]
    async fn process_txs(
        pool: FinalityStagePool,
        building_stage_queue: BuildingStageQueue,
        state: DispatcherState,
        domain: String,
    ) -> Result<(), LanderError> {
        let estimated_block_time = state.adapter.estimated_block_time();
        loop {
            state
                .metrics
                .update_liveness_metric(format!("{STAGE_NAME}::process_txs").as_str(), &domain);
            // evaluate the pool every block
            sleep(*estimated_block_time).await;
            Self::process_txs_step(&pool, &building_stage_queue, &state, &domain).await?;
        }
    }

    pub async fn process_txs_step(
        pool: &FinalityStagePool,
        building_stage_queue: &BuildingStageQueue,
        state: &DispatcherState,
        domain: &str,
    ) -> Result<(), LanderError> {
        state
            .metrics
            .update_liveness_metric(format!("{STAGE_NAME}::process_txs").as_str(), domain);
        let scan_started = Instant::now();
        let mut pool_snapshot = pool.snapshot().await.into_values().collect::<Vec<_>>();
        state
            .metrics
            .update_queue_length_metric(STAGE_NAME, pool_snapshot.len() as u64, domain);
        let now = chrono::Utc::now();
        let oldest_unchecked_age = pool_snapshot
            .iter()
            .filter_map(|tx| {
                now.signed_duration_since(tx.last_status_check.unwrap_or(tx.creation_timestamp))
                    .to_std()
                    .ok()
            })
            .max()
            .unwrap_or_default();
        state
            .metrics
            .update_oldest_unchecked_transaction_age_metric(
                STAGE_NAME,
                oldest_unchecked_age,
                domain,
            );
        super::utils::sort_transactions_for_mutation(&mut pool_snapshot);
        info!(pool_size=?pool_snapshot.len() , "Processing transactions in finality pool");

        let status_batch_size = state
            .adapter
            .tx_status_batch_size()
            .clamp(1, STATUS_READ_CONCURRENCY);
        let status_reads = if status_batch_size == 1 {
            let status_reads = pool_snapshot.into_iter().map(|snapshot_tx| async move {
                let (checked_tx, status) = Self::read_tx_status(snapshot_tx.clone(), state).await;
                (snapshot_tx, checked_tx, status)
            });
            buffer_ordered_bounded(status_reads, STATUS_READ_CONCURRENCY).boxed()
        } else {
            let status_batch_concurrency = STATUS_READ_CONCURRENCY.div_ceil(status_batch_size);
            let status_batches = pool_snapshot
                .chunks(status_batch_size)
                .map(<[Transaction]>::to_vec)
                .collect::<Vec<_>>();
            let status_reads = status_batches.into_iter().map(|batch| {
                read_transaction_status_batch(state, batch, FinalizedStatusRead::TrustPersisted)
            });
            buffer_ordered_bounded(status_reads, status_batch_concurrency)
                .flat_map(futures_util::stream::iter)
                .boxed()
        };
        futures_util::pin_mut!(status_reads);

        while let Some((snapshot_tx, checked_tx, status)) = status_reads.next().await {
            if !pool
                .replace_if_unchanged(&snapshot_tx, checked_tx.clone())
                .await
            {
                info!(tx_uuid = ?snapshot_tx.uuid, "Skipping stale transaction status result");
                continue;
            }
            match status {
                Ok(status) => {
                    if let Err(err) = Self::try_process_tx_with_next_status(
                        checked_tx.clone(),
                        status,
                        pool.clone(),
                        building_stage_queue.clone(),
                        state,
                    )
                    .await
                    {
                        error!(
                            ?err,
                            tx = ?checked_tx,
                            "Error processing finality stage transaction. Skipping for now"
                        );
                    }
                }
                Err(err) => error!(
                    ?err,
                    tx = ?checked_tx,
                    "Error reading finality stage transaction status. Skipping for now"
                ),
            }
        }
        state.metrics.update_status_scan_duration_metric(
            STAGE_NAME,
            scan_started.elapsed(),
            domain,
        );
        Ok(())
    }

    #[cfg(test)]
    #[instrument(
        skip(tx, pool, building_stage_queue, state),
        name = "FinalityStage::try_process_tx"
        fields(
            tx_uuid = ?tx.uuid,
            tx_status = ?tx.status,
            payloads = ?tx.payload_details
    ))]
    pub async fn try_process_tx(
        tx: Transaction,
        pool: FinalityStagePool,
        building_stage_queue: BuildingStageQueue,
        state: &DispatcherState,
    ) -> Result<(), LanderError> {
        info!(?tx, "Processing finality stage transaction");
        let (tx, tx_status) = Self::read_tx_status(tx, state).await;
        Self::try_process_tx_with_next_status(tx, tx_status?, pool, building_stage_queue, state)
            .await
    }

    #[instrument(
        skip_all,
        name = "FinalityStage::read_tx_status",
        fields(tx_uuid = ?tx.uuid, tx_status = ?tx.status, payloads = ?tx.payload_details)
    )]
    async fn read_tx_status(
        mut tx: Transaction,
        state: &DispatcherState,
    ) -> (Transaction, Result<TransactionStatus, LanderError>) {
        tx.last_status_check = Some(chrono::Utc::now());
        let tx_status = match &tx.status {
            TransactionStatus::Finalized => Ok(tx.status.clone()),
            _ => {
                call_until_success_or_nonretryable_error(
                    || state.adapter.tx_status(&tx),
                    "Querying transaction status",
                    state,
                )
                .await
            }
        };
        (tx, tx_status)
    }

    #[instrument(
        skip_all,
        name = "FinalityStage::try_process_tx_with_next_status",
        fields(tx_uuid = ?tx.uuid, previous_tx_status = ?tx.status, next_tx_status = ?tx_status, payloads = ?tx.payload_details)
    )]
    async fn try_process_tx_with_next_status(
        mut tx: Transaction,
        tx_status: TransactionStatus,
        pool: FinalityStagePool,
        building_stage_queue: BuildingStageQueue,
        state: &DispatcherState,
    ) -> Result<(), LanderError> {
        match tx_status {
            TransactionStatus::Included => {
                // tx is not finalized yet, keep it in the pool
                info!(?tx, "Transaction is not yet finalized");
                Self::record_reverted_payloads(&mut tx, state).await?;
            }
            TransactionStatus::Finalized => {
                // update tx status in db
                update_tx_status(state, &mut tx, tx_status).await?;
                Self::record_reverted_payloads(&mut tx, state).await?;
                state.adapter.post_finalized().await?;
                state.notify_reprocess_txs_activity();
                let tx_uuid = tx.uuid.clone();
                info!(?tx_uuid, "Transaction is finalized");
                let _ = pool.remove(&tx_uuid).await;
            }
            TransactionStatus::Dropped(drop_reason) => {
                Self::handle_dropped_transaction(
                    tx.clone(),
                    drop_reason,
                    building_stage_queue.clone(),
                    state,
                    pool,
                )
                .await?;
            }
            TransactionStatus::PendingInclusion | TransactionStatus::Mempool => {
                error!(?tx, "Transaction should not be in the finality stage.");
            }
        }
        Ok(())
    }

    async fn record_reverted_payloads(
        tx: &mut Transaction,
        state: &DispatcherState,
    ) -> Result<(), LanderError> {
        use PayloadDropReason::Reverted;
        use PayloadStatus::Dropped;

        let reverted_payloads = call_until_success_or_nonretryable_error(
            || state.adapter.reverted_payloads(tx),
            "Checking reverted payloads",
            state,
        )
        .await?;
        state
            .update_status_for_payloads(&reverted_payloads, Dropped(Reverted))
            .await;
        Ok(())
    }

    async fn handle_dropped_transaction(
        mut tx: Transaction,
        drop_reason: TxDropReason,
        building_stage_queue: BuildingStageQueue,
        state: &DispatcherState,
        pool: FinalityStagePool,
    ) -> Result<(), LanderError> {
        warn!(?tx, ?drop_reason, "Transaction was dropped");
        // push payloads in tx back to the building stage queue
        update_tx_status(
            state,
            &mut tx,
            TransactionStatus::Dropped(TxDropReason::DroppedByChain),
        )
        .await?;
        let payloads = tx.payload_details.clone();
        for payload in payloads.iter() {
            if let Some(full_payload) = state
                .payload_db
                .retrieve_payload_by_uuid(&payload.uuid)
                .await
                .ok()
                .flatten()
            {
                // update payload status in db
                state
                    .update_status_for_payloads(&[payload.clone()], PayloadStatus::ReadyToSubmit)
                    .await;
                // cannot remove a record from the db, so
                // just link the payload to the null tx id
                state
                    .payload_db
                    .store_tx_uuid_by_payload_uuid(&payload.uuid, &TransactionUuid::default())
                    .await?;
                info!(
                    ?payload,
                    "Pushing payload to the front of the building stage queue"
                );
                building_stage_queue.push_front(full_payload).await;
            }
        }
        let _ = pool.remove(&tx.uuid).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
