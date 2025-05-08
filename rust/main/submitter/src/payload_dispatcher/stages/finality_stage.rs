// TODO: re-enable clippy warnings
#![allow(dead_code)]

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
    error::SubmitterError,
    payload::{DropReason, FullPayload, PayloadStatus},
    payload_dispatcher::stages::utils::update_tx_status,
    transaction::{DropReason as TxDropReason, Transaction, TransactionId, TransactionStatus},
};

use super::{
    building_stage::BuildingStageQueue, utils::call_until_success_or_nonretryable_error,
    PayloadDispatcherState,
};

use pool::FinalityStagePool;

mod pool;

pub const STAGE_NAME: &str = "FinalityStage";

pub struct FinalityStage {
    pub(crate) pool: FinalityStagePool,
    tx_receiver: mpsc::Receiver<Transaction>,
    building_stage_queue: BuildingStageQueue,
    state: PayloadDispatcherState,
    domain: String,
}

impl FinalityStage {
    pub fn new(
        tx_receiver: mpsc::Receiver<Transaction>,
        building_stage_queue: BuildingStageQueue,
        state: PayloadDispatcherState,
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
        state: PayloadDispatcherState,
        domain: String,
    ) -> Result<(), SubmitterError> {
        loop {
            state
                .metrics
                .update_liveness_metric(format!("{}::receive_txs", STAGE_NAME).as_str(), &domain);
            if let Some(tx) = tx_receiver.recv().await {
                let pool_len = pool.insert(tx.clone()).await;
                state.adapter.tx_in_finality(pool_len).await;
                info!(?tx, "Received transaction");
            } else {
                error!("Inclusion stage channel closed");
                return Err(SubmitterError::ChannelClosed);
            }
        }
    }

    async fn process_txs(
        pool: FinalityStagePool,
        building_stage_queue: BuildingStageQueue,
        state: PayloadDispatcherState,
        domain: String,
    ) -> Result<(), SubmitterError> {
        let estimated_block_time = state.adapter.estimated_block_time();
        loop {
            state
                .metrics
                .update_liveness_metric(format!("{}::process_txs", STAGE_NAME).as_str(), &domain);
            // evaluate the pool every block
            sleep(*estimated_block_time).await;

            let pool_snapshot = pool.snapshot().await;
            state.adapter.tx_in_finality(pool_snapshot.len()).await;
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
            tx_id = ?tx.id,
            tx_status = ?tx.status,
            payloads = ?tx.payload_details
    ))]
    async fn try_process_tx(
        mut tx: Transaction,
        pool: FinalityStagePool,
        building_stage_queue: BuildingStageQueue,
        state: &PayloadDispatcherState,
    ) -> Result<(), SubmitterError> {
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
                let reverted_payloads = call_until_success_or_nonretryable_error(
                    || state.adapter.reverted_payloads(&tx),
                    "Checking reverted payloads",
                    state,
                )
                .await?;
                state
                    .update_status_for_payloads(
                        &reverted_payloads,
                        PayloadStatus::Dropped(DropReason::Reverted),
                    )
                    .await;
            }
            TransactionStatus::Finalized => {
                // update tx status in db
                update_tx_status(state, &mut tx, tx_status).await?;
                let tx_id = tx.id.clone();
                info!(?tx_id, "Transaction is finalized");

                let pool_len = pool.remove(&tx_id).await;
                state.adapter.tx_in_finality(pool_len).await;
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

    async fn handle_dropped_transaction(
        mut tx: Transaction,
        drop_reason: TxDropReason,
        building_stage_queue: BuildingStageQueue,
        state: &PayloadDispatcherState,
        pool: FinalityStagePool,
    ) -> Result<(), SubmitterError> {
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
                .retrieve_payload_by_id(&payload.id)
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
                    .store_tx_id_by_payload_id(&payload.id, &TransactionId::default())
                    .await?;
                info!(
                    ?payload,
                    "Pushing payload to the front of the building stage queue"
                );
                building_stage_queue.lock().await.push_front(full_payload);
            }
        }
        let pool_len = pool.remove(&tx.id).await;
        state.adapter.tx_in_finality(pool_len).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        payload::{PayloadDetails, PayloadId},
        payload_dispatcher::{
            metrics::DispatcherMetrics,
            stages::{building_stage, finality_stage},
            test_utils::{
                are_all_txs_in_pool, are_no_txs_in_pool, create_random_txs_and_store_them,
                dummy_tx, initialize_payload_db, tmp_dbs, MockAdapter,
            },
            PayloadDb, TransactionDb,
        },
        transaction::{Transaction, TransactionId},
    };
    use eyre::Result;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn test_processing_included_txs_no_reverted_payload() {
        const TXS_TO_PROCESS: usize = 3;

        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_estimated_block_time()
            .return_const(Duration::from_millis(10));

        mock_adapter
            .expect_tx_status()
            .returning(|_| Ok(TransactionStatus::Included));

        mock_adapter
            .expect_reverted_payloads()
            .returning(|_| Ok(vec![]));

        let (txs_created, txs_removed_from_pool, tx_db, payload_db, pool, _) =
            set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS, TransactionStatus::Included)
                .await;

        assert_eq!(txs_removed_from_pool.len(), 0);
        assert!(are_all_txs_in_pool(txs_created.clone(), &pool).await);
        assert_tx_status(
            txs_removed_from_pool.clone(),
            &tx_db,
            &payload_db,
            TransactionStatus::Included,
        )
        .await;
    }

    #[tokio::test]
    async fn test_processing_included_txs_some_reverted_payload() {
        const TXS_TO_PROCESS: usize = 3;

        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_estimated_block_time()
            .return_const(Duration::from_millis(10));

        mock_adapter
            .expect_tx_status()
            .returning(|_| Ok(TransactionStatus::Included));

        let (payload_db, tx_db) = tmp_dbs();

        let generated_txs = create_random_txs_and_store_them(
            TXS_TO_PROCESS,
            &payload_db,
            &tx_db,
            TransactionStatus::Included,
        )
        .await;

        // these payloads will be reported as reverted
        let payloads_in_first_tx = generated_txs[0].payload_details.clone();
        let payloads_in_first_tx_clone = payloads_in_first_tx.clone();
        mock_adapter
            .expect_reverted_payloads()
            .returning(move |_| Ok(payloads_in_first_tx_clone.clone()));

        let (inclusion_stage_sender, inclusion_stage_receiver) = mpsc::channel(TXS_TO_PROCESS);

        let building_queue = Arc::new(tokio::sync::Mutex::new(VecDeque::new()));

        let state = PayloadDispatcherState::new(
            payload_db.clone(),
            tx_db.clone(),
            Arc::new(mock_adapter),
            DispatcherMetrics::dummy_instance(),
            "test".to_string(),
        );
        let finality_stage = FinalityStage::new(
            inclusion_stage_receiver,
            building_queue.clone(),
            state,
            "test".to_string(),
        );
        let pool = finality_stage.pool.clone();

        send_txs_to_channel(generated_txs.clone(), inclusion_stage_sender).await;
        let txs_received = run_stage(finality_stage).await;

        assert_eq!(txs_received.len(), 0);
        assert!(are_all_txs_in_pool(generated_txs.to_vec(), &pool).await);
        // non-reverted payload txs are still pending finality
        assert_tx_status(
            generated_txs[1..].to_vec(),
            &tx_db,
            &payload_db,
            TransactionStatus::Included,
        )
        .await;
        // reverted payloads are dropped
        assert_payloads_status(
            payloads_in_first_tx.clone(),
            &payload_db,
            PayloadStatus::Dropped(DropReason::Reverted),
        )
        .await;
    }

    #[tokio::test]
    async fn test_processing_finalized_txs() {
        const TXS_TO_PROCESS: usize = 3;

        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_estimated_block_time()
            .return_const(Duration::from_millis(10));

        mock_adapter
            .expect_tx_status()
            .returning(|_| Ok(TransactionStatus::Finalized));

        let (txs_created, txs_received, tx_db, payload_db, pool, _) =
            set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS, TransactionStatus::Finalized)
                .await;

        assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
        assert_tx_status(
            txs_received.clone(),
            &tx_db,
            &payload_db,
            TransactionStatus::Finalized,
        )
        .await;
    }

    #[tokio::test]
    async fn test_processing_reorged_txs() {
        const TXS_TO_PROCESS: usize = 3;

        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_estimated_block_time()
            .return_const(Duration::from_millis(10));

        // report all txs as reorged
        mock_adapter
            .expect_tx_status()
            .returning(|_| Ok(TransactionStatus::Dropped(TxDropReason::DroppedByChain)));

        let (txs_created, txs_received, tx_db, payload_db, pool, queue) =
            set_up_test_and_run_stage(
                mock_adapter,
                TXS_TO_PROCESS,
                TransactionStatus::Dropped(TxDropReason::DroppedByChain),
            )
            .await;

        // the finality pool becomes empty
        assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
        assert_tx_status(
            txs_received.clone(),
            &tx_db,
            &payload_db,
            TransactionStatus::Dropped(TxDropReason::DroppedByChain),
        )
        .await;

        // all payloads are in the building stage queue
        assert_eq!(queue.lock().await.len(), TXS_TO_PROCESS);
        for tx in txs_received {
            assert_payloads_status(
                tx.payload_details.clone(),
                &payload_db,
                PayloadStatus::ReadyToSubmit,
            )
            .await;
        }
    }

    async fn set_up_test_and_run_stage(
        mock_adapter: MockAdapter,
        txs_to_process: usize,
        tx_status: TransactionStatus,
    ) -> (
        Vec<Transaction>,
        Vec<Transaction>,
        Arc<dyn TransactionDb>,
        Arc<dyn PayloadDb>,
        FinalityStagePool,
        BuildingStageQueue,
    ) {
        let (txs_created, tx_db, payload_db, pool, finality_stage, building_queue) =
            set_up_test(mock_adapter, txs_to_process, tx_status).await;
        let txs_received = run_stage(finality_stage).await;
        (
            txs_created,
            txs_received,
            tx_db,
            payload_db,
            pool,
            building_queue,
        )
    }

    async fn set_up_test(
        mock_adapter: MockAdapter,
        txs_to_process: usize,
        tx_status: TransactionStatus,
    ) -> (
        Vec<Transaction>,
        Arc<dyn TransactionDb>,
        Arc<dyn PayloadDb>,
        FinalityStagePool,
        FinalityStage,
        BuildingStageQueue,
    ) {
        let (payload_db, tx_db) = tmp_dbs();
        let (inclusion_stage_sender, inclusion_stage_receiver) = mpsc::channel(txs_to_process);

        let building_queue = Arc::new(tokio::sync::Mutex::new(VecDeque::new()));

        let state = PayloadDispatcherState::new(
            payload_db.clone(),
            tx_db.clone(),
            Arc::new(mock_adapter),
            DispatcherMetrics::dummy_instance(),
            "test".to_string(),
        );
        let finality_stage = FinalityStage::new(
            inclusion_stage_receiver,
            building_queue.clone(),
            state,
            "test".to_string(),
        );
        let pool = finality_stage.pool.clone();

        let test_txs =
            create_random_txs_and_store_them(txs_to_process, &payload_db, &tx_db, tx_status).await;
        send_txs_to_channel(test_txs.clone(), inclusion_stage_sender).await;
        (
            test_txs,
            tx_db,
            payload_db,
            pool,
            finality_stage,
            building_queue,
        )
    }

    async fn send_txs_to_channel(
        txs: Vec<Transaction>,
        inclusion_stage_sender: mpsc::Sender<Transaction>,
    ) {
        for tx in txs {
            inclusion_stage_sender.send(tx).await.unwrap();
        }
    }

    async fn run_stage(stage: FinalityStage) -> Vec<Transaction> {
        let pool = stage.pool.clone();
        let pool_before = pool.snapshot().await;
        let stage_task = tokio::spawn(async move { stage.run().await });
        // give the building stage 100ms to send the transaction(s) to the receiver
        let _ = tokio::select! {
            // this arm runs indefinitely
            res = stage_task => res.unwrap(),
            // this arm is the timeout
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
            },
        };
        let pool_after = pool.snapshot().await;
        pool_before
            .iter()
            .filter(|(id, _)| !pool_after.contains_key(id))
            .map(|(_, tx)| tx.clone())
            .collect::<Vec<_>>()
    }

    async fn assert_tx_status(
        txs: Vec<Transaction>,
        tx_db: &Arc<dyn TransactionDb>,
        payload_db: &Arc<dyn PayloadDb>,
        expected_status: TransactionStatus,
    ) {
        // check that the payload and tx dbs were updated
        for tx in txs {
            let tx_from_db = tx_db
                .retrieve_transaction_by_id(&tx.id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(tx_from_db.status, expected_status.clone());
            assert_payloads_status(
                tx_from_db.payload_details,
                payload_db,
                PayloadStatus::InTransaction(expected_status.clone()),
            )
            .await;
        }
    }

    async fn assert_payloads_status(
        payloads: Vec<PayloadDetails>,
        payload_db: &Arc<dyn PayloadDb>,
        expected_status: PayloadStatus,
    ) {
        for payload in payloads {
            let payload = payload_db
                .retrieve_payload_by_id(&payload.id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(payload.status, expected_status.clone());
        }
    }
}
