use super::*;
use crate::{
    adapter::chains::ethereum::{
        nonce::{
            db::{tests::MockNonceDb, NonceDb},
            NonceManager, NonceManagerState,
        },
        tests::MockEvmProvider,
        EthereumAdapter,
    },
    dispatcher::{
        entrypoint::tests::MockDb,
        finality_stage,
        metrics::DispatcherMetrics,
        test_utils::{
            are_all_txs_in_pool, are_no_txs_in_pool, create_random_txs_and_store_them, dummy_tx,
            initialize_payload_db, tmp_dbs, MockAdapter,
        },
        PayloadDb, TransactionDb,
    },
    transaction::{Transaction, TransactionId},
};
use ethers::types::H160;
use ethers_core::rand::rngs::{adapter, mock};
use eyre::Result;
use hyperlane_base::settings::ChainConf;
use hyperlane_core::{config::OpSubmissionConfig, KnownHyperlaneDomain};
use hyperlane_ethereum::EthereumReorgPeriod;
use std::sync::Arc;
use tokio::{select, sync::mpsc};

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
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));

    mock_adapter.expect_simulate_tx().returning(|_| Ok(true));

    mock_adapter.expect_estimate_tx().returning(|_| Ok(()));

    mock_adapter.expect_submit().returning(|_| Ok(()));

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
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));

    mock_adapter.expect_simulate_tx().returning(|_| Ok(false));

    mock_adapter
        .expect_estimate_tx()
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
    receiver: &mut tokio::sync::mpsc::Receiver<Transaction>,
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

    // give the building stage 100ms to send the transaction(s) to the receiver
    let _ = tokio::select! {
        // this arm runs indefinitely
        res = stage => res,
        // this arm runs until all sent payloads are sent as txs
        received = receiving_closure => {
            return received;
        },
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
