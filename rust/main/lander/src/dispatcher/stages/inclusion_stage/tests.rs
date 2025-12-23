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
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));

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
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));

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
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));

    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);

    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));

    mock_adapter.expect_simulate_tx().returning(|_| {
        Err(LanderError::SimulationFailed(vec![
            "simulation error".to_string()
        ]))
    });

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
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));

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
    let result = tokio::time::timeout(
        Duration::from_millis(100),
        InclusionStage::receive_txs(
            inclusion_stage.tx_receiver,
            inclusion_stage.pool.clone(),
            inclusion_stage.state.clone(),
            inclusion_stage.domain.clone(),
        ),
    )
    .await
    .unwrap();
    assert!(matches!(result, Err(LanderError::ChannelClosed))); // run() should not panic
}

#[tokio::test]
async fn test_transaction_status_dropped() {
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));
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
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));
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
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));
    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));
    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);
    mock_adapter.expect_simulate_tx().returning(|_| Ok(vec![]));
    mock_adapter.expect_estimate_tx().returning(|_| Ok(()));
    mock_adapter.expect_submit().returning(|_| {
        Err(LanderError::SimulationFailed(vec![
            "simulation error".to_string()
        ]))
    });

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
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));
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
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));
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
    // future that receives `sent_txs_count` payloads for the finality stage
    let receiving_closure = async {
        let mut received = Vec::new();
        while received.len() < sent_txs_count {
            tracing::debug!("Received transaction for finality stage");
            let tx_received = receiver.recv().await.unwrap();
            received.push(tx_received);
        }
        received
    };

    let stage = tokio::spawn(async move { stage.run().await });

    // give the inclusion stage more time to send the transaction(s) to the receiver
    // with adaptive polling, we need at least 2 polling cycles (200ms minimum)
    let _ = tokio::select! {
        // this arm runs indefinitely
        res = stage => res,
        // this arm runs until all sent payloads are sent as txs
        received = receiving_closure => {
            return received;
        },
        // this arm is the timeout - increased to accommodate adaptive polling
        _ = sleep(Duration::from_millis(500)) => {
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

#[tokio::test]
async fn test_drop_reason_other_stored_in_db() {
    // Test that when a non-specific error occurs, the transaction is dropped with
    // DropReason::Other containing the error message, and this is properly stored in the DB
    const TXS_TO_PROCESS: usize = 1;

    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));
    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));
    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);
    mock_adapter.expect_simulate_tx().returning(|_| Ok(vec![]));
    mock_adapter.expect_estimate_tx().returning(|_| Ok(()));

    // Return a generic error that should be caught and converted to Other variant
    mock_adapter.expect_submit().returning(|_| {
        Err(LanderError::NetworkError(
            "Custom network failure".to_string(),
        ))
    });

    let (txs_created, txs_received, tx_db, payload_db, pool) =
        set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

    // Transaction should be dropped from the pool
    assert_eq!(txs_received.len(), 0);
    assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);

    // Verify the transaction was dropped with the Other variant containing the error message
    for tx in txs_created {
        let tx_from_db = tx_db
            .retrieve_transaction_by_uuid(&tx.uuid)
            .await
            .unwrap()
            .unwrap();

        match tx_from_db.status {
            TransactionStatus::Dropped(TxDropReason::Other(ref msg)) => {
                assert!(
                    msg.contains("Custom network failure"),
                    "Expected error message to contain 'Custom network failure', but got: {}",
                    msg
                );
            }
            _ => panic!(
                "Expected TransactionStatus::Dropped(TxDropReason::Other(_)), but got: {:?}",
                tx_from_db.status
            ),
        }

        // Verify payloads are also marked as dropped
        for detail in tx.payload_details.iter() {
            let payload = payload_db
                .retrieve_payload_by_uuid(&detail.uuid)
                .await
                .unwrap()
                .unwrap();

            match payload.status {
                PayloadStatus::InTransaction(TransactionStatus::Dropped(TxDropReason::Other(ref msg))) => {
                    assert!(
                        msg.contains("Custom network failure"),
                        "Expected payload error message to contain 'Custom network failure', but got: {}",
                        msg
                    );
                }
                _ => panic!(
                    "Expected PayloadStatus::InTransaction(TransactionStatus::Dropped(TxDropReason::Other(_))), but got: {:?}",
                    payload.status
                ),
            }
        }
    }
}

#[tokio::test]
async fn test_reasonable_receipt_query_frequency() {
    // This test enforces reasonable eth_getTransactionReceipt query frequency
    // It will FAIL with the current 10ms polling implementation
    // and PASS once we implement adaptive polling based on block time

    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc as StdArc;

    let call_counter = StdArc::new(AtomicU32::new(0));
    let call_counter_clone = call_counter.clone();

    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_reprocess_txs_poll_rate()
        .returning(|| None);
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(12000)); // Ethereum block time ~12s

    // Track how many times tx_status is called (which triggers get_transaction_receipt)
    mock_adapter.expect_tx_status().returning(move |_| {
        call_counter_clone.fetch_add(1, Ordering::SeqCst);
        Ok(TransactionStatus::PendingInclusion) // Always pending to keep it in the pool
    });

    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| false); // Don't resubmit to avoid extra complexity

    let (payload_db, tx_db, _) = tmp_dbs();
    let (building_stage_sender, building_stage_receiver) = mpsc::channel(5);
    let (finality_stage_sender, _finality_stage_receiver) = mpsc::channel(5);

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

    // Create 3 transactions that will stay pending
    const NUM_TXS: usize = 3;
    let txs_created = create_random_txs_and_store_them(
        NUM_TXS,
        &payload_db,
        &tx_db,
        TransactionStatus::PendingInclusion,
    )
    .await;

    // Send transactions to inclusion stage
    for tx in txs_created.iter() {
        building_stage_sender.send(tx.clone()).await.unwrap();
    }

    // Let the inclusion stage run for 1 second to get a good sample
    let stage_handle = tokio::spawn(async move { inclusion_stage.run().await });

    sleep(Duration::from_millis(1000)).await;
    stage_handle.abort();

    let total_calls = call_counter.load(Ordering::SeqCst);
    let queries_per_second = total_calls as f64 / 1.0;
    let queries_per_second_per_tx = queries_per_second / NUM_TXS as f64;

    println!("Total tx_status calls (receipt queries) in 1 second: {total_calls}");
    println!("Queries per second per transaction: {queries_per_second_per_tx:.2}");

    // REASONABLE EXPECTATIONS FOR ETHEREUM (12s block time):
    // - New transactions: Check every 3s (1/4 block time) = 0.33 queries/sec/tx
    // - Older transactions: Exponential backoff, average ~0.1 queries/sec/tx
    // - For 3 transactions: Maximum ~1 query/sec total

    // This test will FAIL with current 10ms implementation (making ~80 queries/sec/tx)
    // but PASS with adaptive polling (making ~0.1-0.3 queries/sec/tx)

    assert!(
        queries_per_second <= 5.0,
        "Too many receipt queries! Expected ≤5 queries/sec total, got {queries_per_second:.1}. \
        Current implementation makes {queries_per_second_per_tx:.1} queries/sec/tx but should make ≤0.5 queries/sec/tx"
    );

    assert!(
        queries_per_second_per_tx <= 1.0,
        "Receipt queries per transaction too high! Expected ≤1.0 queries/sec/tx, got {queries_per_second_per_tx:.2}. \
        With 12s Ethereum blocks, should check at most every 3s (0.33 queries/sec/tx)"
    );
}

#[tokio::test]
async fn test_processing_reprocess_txs() {
    let txs_to_process = 4;
    let (payload_db, tx_db, _) = tmp_dbs();
    let (_sender, building_stage_receiver) = mpsc::channel(txs_to_process);
    let (finality_stage_sender, _receiver) = mpsc::channel(txs_to_process);
    let txs_created = create_random_txs_and_store_them(
        txs_to_process,
        &payload_db,
        &tx_db,
        TransactionStatus::PendingInclusion,
    )
    .await;

    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(400));
    mock_adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));
    mock_adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| false);

    mock_adapter
        .expect_reprocess_txs_poll_rate()
        .return_const(Some(Duration::from_millis(50)));
    let mut txs_created_option = Some(txs_created.clone());
    mock_adapter.expect_get_reprocess_txs().returning(move || {
        if let Some(txs) = txs_created_option.take() {
            Ok(txs)
        } else {
            Ok(Vec::new())
        }
    });

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

    let stage = tokio::spawn(async move { inclusion_stage.run().await });
    tokio::select! {
        // this arm runs indefinitely
        _ = stage => {
        },
        // this arm is the timeout - increased to accommodate adaptive polling
        _ = sleep(Duration::from_millis(500)) => {
        }
    };

    assert!(are_all_txs_in_pool(txs_created.clone(), &pool).await);
}
