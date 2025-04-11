use std::{collections::VecDeque, sync::Arc, time::Duration};

use tokio::{sync::Mutex, time::sleep};

use crate::{
    chain_tx_adapter::TxBuildingResult,
    payload_dispatcher::{
        metrics::Metrics,
        test_utils::{dummy_tx, tmp_dbs, MockAdapter},
        BuildingStageQueue, PayloadDbLoader, PayloadDispatcherState,
    },
    Entrypoint, FullPayload, PayloadDispatcher, PayloadDispatcherEntrypoint, PayloadStatus,
    TransactionStatus,
};

#[tokio::test]
async fn test_entrypoint_send_is_detected_by_loader() {
    let (payload_db, tx_db) = tmp_dbs();
    let building_stage_queue = Arc::new(Mutex::new(VecDeque::new()));
    let payload_db_loader = PayloadDbLoader::new(payload_db.clone(), building_stage_queue.clone());
    let mut payload_iterator = payload_db_loader.into_iterator().await;

    let metrics = Metrics::dummy_instance();
    let adapter = Arc::new(MockAdapter::new());
    let state = PayloadDispatcherState::new(
        payload_db,
        tx_db,
        adapter,
        metrics.clone(),
        "dummy_domain".to_string(),
    );
    let dispatcher_entrypoint = PayloadDispatcherEntrypoint {
        inner: state.clone(),
    };

    let _payload_db_loader = tokio::spawn(async move {
        payload_iterator
            .load_from_db(metrics.clone())
            .await
            .expect("Payload loader crashed");
    });

    // Simulate writing to the database
    let payload = FullPayload::random();
    dispatcher_entrypoint.send_payload(&payload).await.unwrap();

    // Check if the loader detects the new payload
    sleep(Duration::from_millis(100)).await; // Wait for the loader to process the payload
    let detected_payload_count = {
        let queue = building_stage_queue.lock().await;
        queue.len()
    };
    assert_eq!(
        detected_payload_count, 1,
        "Loader did not detect the new payload"
    );
}

#[tokio::test]
async fn test_entrypoint_send_is_finalized_by_dispatcher() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .try_init();

    let (payload_db, tx_db) = tmp_dbs();
    let building_stage_queue = Arc::new(Mutex::new(VecDeque::new()));
    let payload_db_loader = PayloadDbLoader::new(payload_db.clone(), building_stage_queue.clone());
    let mut payload_iterator = payload_db_loader.into_iterator().await;
    let payload = FullPayload::random();

    let mut adapter = MockAdapter::new();
    adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(100));

    let tx = dummy_tx(vec![payload.clone()], TransactionStatus::PendingInclusion);
    let tx_building_result = TxBuildingResult::new(vec![payload.details.clone()], Some(tx));
    let txs = vec![tx_building_result];
    adapter
        .expect_build_transactions()
        .returning(move |_| txs.clone());
    adapter.expect_simulate_tx().returning(move |_| Ok(true));
    let mut counter = 0;
    adapter.expect_tx_status().returning(move |_| {
        counter += 1;
        match counter {
            1 => Ok(TransactionStatus::PendingInclusion),
            2 => Ok(TransactionStatus::PendingInclusion),
            3 => Ok(TransactionStatus::Included),
            4 => Ok(TransactionStatus::Included),
            5 => Ok(TransactionStatus::Included),
            _ => Ok(TransactionStatus::Finalized),
        }
    });
    adapter.expect_reverted_payloads().returning(|_| Ok(vec![]));

    adapter.expect_simulate_tx().returning(|_| Ok(true));

    adapter.expect_submit().returning(|_| Ok(()));

    let adapter = Arc::new(adapter);
    let metrics = Metrics::dummy_instance();
    let domain = "test_domain".to_string();

    let state =
        PayloadDispatcherState::new(payload_db, tx_db, adapter, metrics.clone(), domain.clone());
    let dispatcher_entrypoint = PayloadDispatcherEntrypoint {
        inner: state.clone(),
    };

    let metrics_to_move = metrics.clone();
    let _payload_db_loader = tokio::spawn(async move {
        payload_iterator
            .load_from_db(metrics_to_move)
            .await
            .expect("Payload loader crashed");
    });

    let payload_dispatcher = PayloadDispatcher {
        inner: state.clone(),
        domain: domain.clone(),
    };
    let _payload_dispatcher = tokio::spawn(async move { payload_dispatcher.spawn().await });

    dispatcher_entrypoint.send_payload(&payload).await.unwrap();

    // wait until the payload status is InTransaction(Finalized)
    loop {
        let stored_payload = state
            .payload_db
            .retrieve_payload_by_id(payload.id())
            .await
            .unwrap()
            .unwrap();
        if stored_payload.status == PayloadStatus::InTransaction(TransactionStatus::Finalized) {
            break;
        }
        sleep(Duration::from_millis(100)).await;
    }
    sleep(Duration::from_millis(200)).await; // Wait for the metrics to be updated

    // check metrics
    let gathered_metrics = metrics.gather().unwrap();
    let metrics_str = String::from_utf8(gathered_metrics).unwrap();
    println!("Metrics: {}", metrics_str);

    let metrics = metrics.dispatcher_metrics.unwrap();
    let finalized_txs = metrics
        .finalized_transactions
        .with_label_values(&[&state.domain])
        .get();
    assert_eq!(
        finalized_txs, 1,
        "Finalized transactions metric is incorrect for domain {}",
        state.domain
    );
    let building_stage_queue_length = metrics
        .building_stage_queue_length
        .with_label_values(&[&state.domain])
        .get();
    assert_eq!(
        building_stage_queue_length, 0,
        "Building stage queue length metric is incorrect"
    );
    let inclusion_stage_pool_length = metrics
        .inclusion_stage_pool_length
        .with_label_values(&[&state.domain])
        .get();
    assert_eq!(
        inclusion_stage_pool_length, 0,
        "Inclusion stage pool length metric is incorrect"
    );
    let finality_stage_pool_length = metrics
        .finality_stage_pool_length
        .with_label_values(&[&state.domain])
        .get();
    assert_eq!(
        finality_stage_pool_length, 0,
        "Finality stage pool length metric is incorrect"
    );
}
