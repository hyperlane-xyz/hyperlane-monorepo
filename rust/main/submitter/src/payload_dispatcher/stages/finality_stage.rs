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
use tracing::{error, info, info_span, warn, Instrument};

use crate::{
    chain_tx_adapter::DispatcherError,
    payload::{DropReason, FullPayload, PayloadStatus},
    payload_dispatcher::stages::utils::update_tx_status,
    transaction::{DropReason as TxDropReason, Transaction, TransactionId, TransactionStatus},
};

use super::{
    building_stage::BuildingStageQueue, utils::retry_until_success, PayloadDispatcherState,
};

pub type FinalityStagePool = Arc<Mutex<HashMap<TransactionId, Transaction>>>;

#[derive(new)]
struct FinalityStage {
    pool: FinalityStagePool,
    inclusion_stage_receiver: mpsc::Receiver<Transaction>,
    building_stage_queue: BuildingStageQueue,
    state: PayloadDispatcherState,
}

impl FinalityStage {
    pub async fn run(self) {
        let FinalityStage {
            pool,
            inclusion_stage_receiver,
            building_stage_queue,
            state,
        } = self;
        let futures = vec![
            tokio::spawn(
                Self::receive_txs(inclusion_stage_receiver, pool.clone())
                    .instrument(info_span!("receive_txs")),
            ),
            tokio::spawn(
                Self::process_txs(pool, building_stage_queue, state)
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
        mut inclusion_stage_receiver: mpsc::Receiver<Transaction>,
        pool: FinalityStagePool,
    ) -> Result<(), DispatcherError> {
        loop {
            let tx = inclusion_stage_receiver.recv().await.unwrap();
            pool.lock().await.insert(tx.id.clone(), tx.clone());
            info!(?tx, "Received transaction");
        }
    }

    async fn process_txs(
        pool: FinalityStagePool,
        building_stage_queue: BuildingStageQueue,
        state: PayloadDispatcherState,
    ) -> Result<(), DispatcherError> {
        let estimated_block_time = state.adapter.estimated_block_time();
        loop {
            // evaluate the pool every block
            sleep(estimated_block_time).await;

            let pool_snapshot = pool.lock().await.clone();
            for (_, tx) in pool_snapshot {
                if let Err(err) = Self::try_process_tx(
                    tx.clone(),
                    pool.clone(),
                    building_stage_queue.clone(),
                    &state,
                )
                .await
                {
                    error!(?err, ?tx, "Error processing transaction. Skipping for now");
                }
            }
        }
    }

    async fn try_process_tx(
        mut tx: Transaction,
        pool: FinalityStagePool,
        building_stage_queue: BuildingStageQueue,
        state: &PayloadDispatcherState,
    ) -> Result<(), DispatcherError> {
        let tx_status = retry_until_success(
            || state.adapter.tx_status(&tx),
            "Querying transaction status",
        )
        .await;

        match tx_status {
            TransactionStatus::Included => {
                // tx is not finalized yet, keep it in the pool
                info!(?tx, "Transaction is not yet finalized");
                let reverted_payloads = retry_until_success(
                    || state.adapter.reverted_payloads(&tx),
                    "Checking reverted payloads",
                )
                .await;
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
                pool.lock().await.remove(&tx_id);
            }
            TransactionStatus::Dropped(drop_reason) => {
                Self::handle_dropped_transaction(
                    tx.clone(),
                    drop_reason,
                    building_stage_queue.clone(),
                    state,
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
    ) -> Result<(), DispatcherError> {
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
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        payload::{PayloadDb, PayloadId},
        payload_dispatcher::{
            stages::building_stage,
            test_utils::tests::{
                create_random_txs_and_store_them, dummy_tx, initialize_payload_db, tmp_dbs,
                MockAdapter,
            },
        },
        transaction::{Transaction, TransactionDb, TransactionId},
    };
    use eyre::Result;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn test_process_included_txs() {}

    #[tokio::test]
    async fn test_processing_included_txs() {
        const TXS_TO_PROCESS: usize = 3;

        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_estimated_block_time()
            .returning(|| Duration::from_millis(10));

        mock_adapter
            .expect_tx_status()
            .returning(|_| Ok(TransactionStatus::Included));

        mock_adapter
            .expect_reverted_payloads()
            .returning(|_| Ok(vec![]));

        let (txs_created, txs_received, tx_db, payload_db, pool) =
            set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

        // assert_eq!(txs_received.len(), TXS_TO_PROCESS);
        assert!(are_all_txs_in_pool(txs_created.clone(), &pool).await);
        assert_tx_status(
            txs_received.clone(),
            &tx_db,
            &payload_db,
            TransactionStatus::Included,
        )
        .await;
    }

    // #[tokio::test]
    // async fn test_unincluded_txs_reach_mempool() {
    //     const TXS_TO_PROCESS: usize = 3;

    //     let mut mock_adapter = MockAdapter::new();
    //     mock_adapter
    //         .expect_estimated_block_time()
    //         .returning(|| Duration::from_millis(10));

    //     mock_adapter
    //         .expect_tx_status()
    //         .returning(|_| Ok(TransactionStatus::PendingInclusion));

    //     mock_adapter.expect_simulate_tx().returning(|_| Ok(true));

    //     mock_adapter.expect_submit().returning(|_| Ok(()));

    //     let (txs_created, txs_received, tx_db, payload_db, pool) =
    //         set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

    //     assert_eq!(txs_received.len(), 0);
    //     assert_txs_not_in_db(txs_created.clone(), &pool).await;
    //     assert_tx_status(
    //         txs_received.clone(),
    //         &tx_db,
    //         &payload_db,
    //         TransactionStatus::Mempool,
    //     )
    //     .await;
    // }

    // #[tokio::test]
    // async fn test_failed_simulation() {
    //     const TXS_TO_PROCESS: usize = 3;

    //     let mut mock_adapter = MockAdapter::new();
    //     mock_adapter
    //         .expect_estimated_block_time()
    //         .returning(|| Duration::from_millis(10));

    //     mock_adapter
    //         .expect_tx_status()
    //         .returning(|_| Ok(TransactionStatus::PendingInclusion));

    //     mock_adapter.expect_simulate_tx().returning(|_| Ok(false));

    //     let (txs_created, txs_received, tx_db, payload_db, pool) =
    //         set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

    //     assert_eq!(txs_received.len(), 0);
    //     assert_txs_not_in_db(txs_created.clone(), &pool).await;
    //     assert_tx_status(
    //         txs_received.clone(),
    //         &tx_db,
    //         &payload_db,
    //         TransactionStatus::Dropped(TxDropReason::FailedSimulation),
    //     )
    //     .await;
    // }

    async fn are_all_txs_in_pool(txs: Vec<Transaction>, pool: &FinalityStagePool) -> bool {
        let pool = pool.lock().await;
        txs.iter().all(|tx| pool.contains_key(&tx.id))
    }

    async fn set_up_test_and_run_stage(
        mock_adapter: MockAdapter,
        txs_to_process: usize,
    ) -> (
        Vec<Transaction>,
        Vec<Transaction>,
        Arc<dyn TransactionDb>,
        Arc<dyn PayloadDb>,
        FinalityStagePool,
    ) {
        let (payload_db, tx_db) = tmp_dbs();
        let (inclusion_stage_sender, inclusion_stage_receiver) = mpsc::channel(txs_to_process);

        let building_queue = Arc::new(tokio::sync::Mutex::new(VecDeque::new()));

        let state =
            PayloadDispatcherState::new(payload_db.clone(), tx_db.clone(), Box::new(mock_adapter));
        let pool = Arc::new(Mutex::new(HashMap::new()));
        let finality_stage = FinalityStage::new(
            pool.clone(),
            inclusion_stage_receiver,
            building_queue.clone(),
            state,
        );

        let txs_created =
            create_random_txs_and_store_them(txs_to_process, &payload_db, &tx_db).await;
        for tx in txs_created.iter() {
            inclusion_stage_sender.send(tx.clone()).await.unwrap();
        }
        let txs_received = run_stage(txs_to_process, finality_stage, building_queue).await;
        (txs_created, txs_received, tx_db, payload_db, pool)
    }

    async fn run_stage(
        sent_txs_count: usize,
        stage: FinalityStage,
        building_stage_queue: BuildingStageQueue,
    ) -> Vec<Transaction> {
        let stage = tokio::spawn(async move { stage.run().await });
        // give the building stage 100ms to send the transaction(s) to the receiver
        let _ = tokio::select! {
            // this arm runs indefinitely
            res = stage => res,
            // this arm is the timeout
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                return vec![]
            },
        };
        vec![]
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

            for detail in tx.payload_details.iter() {
                let payload = payload_db
                    .retrieve_payload_by_id(&detail.id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    payload.status,
                    PayloadStatus::InTransaction(expected_status.clone())
                );
            }
        }
    }
}
