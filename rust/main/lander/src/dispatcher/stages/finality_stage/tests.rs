use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::tests::test_utils::{
    are_all_txs_in_pool, are_no_txs_in_pool, create_random_txs_and_store_them, tmp_dbs, MockAdapter,
};
use crate::{
    dispatcher::{metrics::DispatcherMetrics, PayloadDb, TransactionDb},
    payload::PayloadDetails,
    transaction::Transaction,
};

use super::*;

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
        set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS, TransactionStatus::Included).await;

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

    let (payload_db, tx_db, _) = tmp_dbs();

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

    let building_queue = BuildingStageQueue::new();

    let state = DispatcherState::new(
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
        PayloadStatus::Dropped(PayloadDropReason::Reverted),
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

    mock_adapter
        .expect_reverted_payloads()
        .returning(|_| Ok(vec![]));

    let (txs_created, txs_received, tx_db, payload_db, pool, _) =
        set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS, TransactionStatus::Finalized).await;

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

    let (txs_created, txs_received, tx_db, payload_db, pool, queue) = set_up_test_and_run_stage(
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
    assert_eq!(queue.len().await, TXS_TO_PROCESS);
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
    let (payload_db, tx_db, _) = tmp_dbs();
    let (inclusion_stage_sender, inclusion_stage_receiver) = mpsc::channel(txs_to_process);

    let building_queue = BuildingStageQueue::new();

    let state = DispatcherState::new(
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
            .retrieve_transaction_by_uuid(&tx.uuid)
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
            .retrieve_payload_by_uuid(&payload.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(payload.status, expected_status.clone());
    }
}
