use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    sync::Arc,
    time::Duration,
};

use derive_new::new;
use eyre::{eyre, Result};
use futures_util::future::try_join_all;
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
    building_stage::BuildingStageQueue, utils::call_until_success_or_nonretryable_error,
    DispatcherState,
};

use pool::FinalityStagePool;

mod pool;

pub const STAGE_NAME: &str = "FinalityStage";

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
                    .instrument(info_span!("receive_txs")),
            ),
            tokio::spawn(
                Self::process_txs(pool, building_stage_queue, state, domain)
                    .instrument(info_span!("process_txs")),
            ),
        ];
        if let Err(err) = try_join_all(futures).await {
            error!(
                error=?err,
                "Finality stage future panicked"
            );
        }
    }

    async fn receive_txs(
        mut tx_receiver: mpsc::Receiver<Transaction>,
        pool: FinalityStagePool,
        state: DispatcherState,
        domain: String,
    ) -> Result<(), LanderError> {
        loop {
            state
                .metrics
                .update_liveness_metric(format!("{}::receive_txs", STAGE_NAME).as_str(), &domain);
            if let Some(tx) = tx_receiver.recv().await {
                let _ = pool.insert(tx.clone()).await;
                info!(?tx, "Received transaction");
            } else {
                error!("Inclusion stage channel closed");
                return Err(LanderError::ChannelClosed);
            }
        }
    }

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
                .update_liveness_metric(format!("{}::process_txs", STAGE_NAME).as_str(), &domain);
            // evaluate the pool every block
            sleep(*estimated_block_time).await;

            let pool_snapshot = pool.snapshot().await;
            state.metrics.update_queue_length_metric(
                STAGE_NAME,
                pool_snapshot.len() as u64,
                &domain,
            );
            info!(pool_size=?pool_snapshot.len() , "Processing transactions in finality pool");
            for (_, tx) in pool_snapshot {
                if let Err(err) = Self::try_process_tx(
                    tx.clone(),
                    pool.clone(),
                    building_stage_queue.clone(),
                    &state,
                )
                .await
                {
                    error!(
                        ?err,
                        ?tx,
                        "Error processing finality stage transaction. Skipping for now"
                    );
                }
            }
        }
    }

    #[instrument(
        skip(tx, pool, building_stage_queue, state),
        name = "FinalityStage::try_process_tx"
        fields(
            tx_uuid = ?tx.uuid,
            tx_status = ?tx.status,
            payloads = ?tx.payload_details
    ))]
    async fn try_process_tx(
        mut tx: Transaction,
        pool: FinalityStagePool,
        building_stage_queue: BuildingStageQueue,
        state: &DispatcherState,
    ) -> Result<(), LanderError> {
        info!(?tx, "Processing finality stage transaction");
        let tx_status = call_until_success_or_nonretryable_error(
            || state.adapter.tx_status(&tx),
            "Querying transaction status",
            state,
        )
        .await?;

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
