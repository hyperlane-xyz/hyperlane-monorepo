use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::time::sleep;

use crate::dispatcher::{
    metrics::DispatcherMetrics, DispatcherState, InclusionStage, InclusionStagePool, PayloadDb,
    TransactionDb,
};
use crate::error::LanderError;
use crate::payload::{DropReason as PayloadDropReason, PayloadStatus};
use crate::tests::test_utils::{
    are_all_txs_in_pool, are_no_txs_in_pool, create_random_txs_and_store_them, tmp_dbs, MockAdapter,
};
use crate::transaction::{DropReason as TxDropReason, Transaction, TransactionStatus};

#[tokio::test]
async fn test_processing_included_txs() {
    const TXS_TO_PROCESS: usize = 3;

    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(10));

    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::Included));

    let (txs_created, txs_received, tx_db, payload_db, pool) =
        set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

    assert_eq!(txs_received.len(), TXS_TO_PROCESS);
    assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
    assert_tx_status(
        txs_received.clone(),
        &tx_db,
        &payload_db,
        TransactionStatus::Included,
    )
    .await;
}

#[tokio::test]
async fn test_unincluded_txs_reach_mempool() {
    const TXS_TO_PROCESS: usize = 3;

    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(10));

    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);

    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));

    mock_adapter.expect_simulate_tx().returning(|_| Ok(vec![]));

    mock_adapter.expect_estimate_tx().returning(|_| Ok(()));

    mock_adapter.expect_submit().returning(|_| Ok(()));

    mock_adapter
        .expect_update_vm_specific_metrics()
        .returning(|_, _| ());

    let (txs_created, txs_received, tx_db, payload_db, pool) =
        set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

    assert_eq!(txs_received.len(), 0);
    assert!(are_all_txs_in_pool(txs_created.clone(), &pool).await);
    assert_tx_status(
        txs_received.clone(),
        &tx_db,
        &payload_db,
        TransactionStatus::Mempool,
    )
    .await;
}

#[tokio::test]
async fn test_failed_simulation() {
    const TXS_TO_PROCESS: usize = 3;

    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(10));

    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);

    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));

    mock_adapter
        .expect_simulate_tx()
        .returning(|_| Err(LanderError::SimulationFailed));

    let (txs_created, txs_received, tx_db, payload_db, pool) =
        set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

    assert_eq!(txs_received.len(), 0);
    assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
    assert_tx_status(
        txs_received.clone(),
        &tx_db,
        &payload_db,
        TransactionStatus::Dropped(TxDropReason::FailedSimulation),
    )
    .await;
}

#[tokio::test]
async fn test_failed_estimation() {
    const TXS_TO_PROCESS: usize = 3;

    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(10));

    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));

    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);

    mock_adapter.expect_simulate_tx().returning(|_| Ok(vec![]));

    mock_adapter
        .expect_estimate_tx()
        .returning(|_| Err(LanderError::EstimationFailed));

    let (txs_created, txs_received, tx_db, payload_db, pool) =
        set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

    assert_eq!(txs_received.len(), 0);
    assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
    assert_tx_status(
        txs_received.clone(),
        &tx_db,
        &payload_db,
        TransactionStatus::Dropped(TxDropReason::FailedSimulation),
    )
    .await;
}

#[tokio::test]
async fn test_channel_closed_before_any_tx() {
    let (payload_db, tx_db, _) = tmp_dbs();
    let (building_stage_sender, building_stage_receiver) = mpsc::channel(1);
    let (finality_stage_sender, _finality_stage_receiver) = mpsc::channel(1);

    let state = DispatcherState::new(
        payload_db.clone(),
        tx_db.clone(),
        Arc::new(MockAdapter::new()),
        DispatcherMetrics::dummy_instance(),
        "test".to_string(),
    );
    let inclusion_stage = InclusionStage::new(
        building_stage_receiver,
        finality_stage_sender,
        state,
        "test".to_string(),
    );

    // Drop sender before running stage
    drop(building_stage_sender);

    // Should return error due to closed channel
    let result = tokio::time::timeout(Duration::from_millis(100), inclusion_stage.run()).await;
    assert!(result.is_ok()); // run() should not panic
}

#[tokio::test]
async fn test_transaction_status_dropped() {
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(10));
    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::Dropped(TxDropReason::FailedSimulation)));

    let (txs_created, txs_received, tx_db, payload_db, pool) =
        set_up_test_and_run_stage(mock_adapter, 1).await;

    assert_eq!(txs_received.len(), 0);
    assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
    assert_tx_status(
        txs_received.clone(),
        &tx_db,
        &payload_db,
        TransactionStatus::Dropped(TxDropReason::FailedSimulation),
    )
    .await;
}

#[tokio::test]
async fn test_transaction_not_ready_for_resubmission() {
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(10));
    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));
    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| false);

    let (txs_created, txs_received, tx_db, payload_db, pool) =
        set_up_test_and_run_stage(mock_adapter, 1).await;

    assert_eq!(txs_received.len(), 0);
    assert!(are_all_txs_in_pool(txs_created.clone(), &pool).await);
    assert_tx_status(
        txs_received.clone(),
        &tx_db,
        &payload_db,
        TransactionStatus::PendingInclusion,
    )
    .await;
}

#[tokio::test]
async fn test_failed_submission_after_simulation_and_estimation() {
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(10));
    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));
    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);
    mock_adapter.expect_simulate_tx().returning(|_| Ok(vec![]));
    mock_adapter.expect_estimate_tx().returning(|_| Ok(()));
    mock_adapter
        .expect_submit()
        .returning(|_| Err(LanderError::SimulationFailed));

    let (txs_created, txs_received, tx_db, payload_db, pool) =
        set_up_test_and_run_stage(mock_adapter, 1).await;

    assert_eq!(txs_received.len(), 0);
    assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
    assert_tx_status(
        txs_received.clone(),
        &tx_db,
        &payload_db,
        TransactionStatus::Dropped(TxDropReason::FailedSimulation),
    )
    .await;
}

#[tokio::test]
async fn test_transaction_included_immediately() {
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(10));
    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::Included));

    let (txs_created, txs_received, tx_db, payload_db, pool) =
        set_up_test_and_run_stage(mock_adapter, 1).await;

    assert_eq!(txs_received.len(), 1);
    assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
    assert_tx_status(
        txs_received.clone(),
        &tx_db,
        &payload_db,
        TransactionStatus::Included,
    )
    .await;
}

#[tokio::test]
async fn test_transaction_pending_then_included() {
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(10));
    let mut call_count = 0;
    mock_adapter.expect_tx_status().returning(move |_| {
        call_count += 1;
        if call_count == 1 {
            Ok(TransactionStatus::PendingInclusion)
        } else {
            Ok(TransactionStatus::Included)
        }
    });
    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);
    mock_adapter.expect_simulate_tx().returning(|_| Ok(vec![]));
    mock_adapter.expect_estimate_tx().returning(|_| Ok(()));
    mock_adapter.expect_submit().returning(|_| Ok(()));
    mock_adapter
        .expect_update_vm_specific_metrics()
        .returning(|_, _| ());

    let (txs_created, txs_received, tx_db, payload_db, pool) =
        set_up_test_and_run_stage(mock_adapter, 1).await;

    // Should eventually be included
    assert_eq!(txs_received.len(), 1);
    assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
    assert_tx_status(
        txs_received.clone(),
        &tx_db,
        &payload_db,
        TransactionStatus::Included,
    )
    .await;
}

async fn set_up_test_and_run_stage(
    mock_adapter: MockAdapter,
    txs_to_process: usize,
) -> (
    Vec<Transaction>,
    Vec<Transaction>,
    Arc<dyn TransactionDb>,
    Arc<dyn PayloadDb>,
    InclusionStagePool,
) {
    let (payload_db, tx_db, _) = tmp_dbs();
    let (building_stage_sender, building_stage_receiver) = mpsc::channel(txs_to_process);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(txs_to_process);

    let state = DispatcherState::new(
        payload_db.clone(),
        tx_db.clone(),
        Arc::new(mock_adapter),
        DispatcherMetrics::dummy_instance(),
        "test".to_string(),
    );
    let inclusion_stage = InclusionStage::new(
        building_stage_receiver,
        finality_stage_sender,
        state,
        "test".to_string(),
    );
    let pool = inclusion_stage.pool.clone();

    let txs_created = create_random_txs_and_store_them(
        txs_to_process,
        &payload_db,
        &tx_db,
        TransactionStatus::PendingInclusion,
    )
    .await;
    for tx in txs_created.iter() {
        building_stage_sender.send(tx.clone()).await.unwrap();
    }
    let txs_received = run_stage(
        txs_to_process,
        inclusion_stage,
        &mut finality_stage_receiver,
    )
    .await;
    (txs_created, txs_received, tx_db, payload_db, pool)
}

async fn run_stage(
    sent_txs_count: usize,
    stage: InclusionStage,
    receiver: &mut mpsc::Receiver<Transaction>,
) -> Vec<Transaction> {
    // future that receives `sent_payload_count` payloads from the building stage
    let receiving_closure = async {
        let mut received = Vec::new();
        while received.len() < sent_txs_count {
            let tx_received = receiver.recv().await.unwrap();
            received.push(tx_received);
        }
        received
    };

    let stage = tokio::spawn(async move { stage.run().await });

    // give the inclusion stage 100ms to send the transaction(s) to the receiver
    let _ = tokio::select! {
        // this arm runs indefinitely
        res = stage => res,
        // this arm runs until all sent payloads are sent as txs
        received = receiving_closure => {
            return received;
        },
        // this arm is the timeout
        _ = sleep(Duration::from_millis(100)) => {
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
            .retrieve_transaction_by_uuid(&tx.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tx_from_db.status, expected_status.clone());

        for detail in tx.payload_details.iter() {
            let payload = payload_db
                .retrieve_payload_by_uuid(&detail.uuid)
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
