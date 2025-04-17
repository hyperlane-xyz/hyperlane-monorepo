use std::{collections::VecDeque, sync::Arc, time::Duration};

use tokio::{sync::Mutex, time::sleep};

use crate::{
    chain_tx_adapter::TxBuildingResult,
    payload_dispatcher::{
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

    let adapter = Arc::new(MockAdapter::new());
    let state = PayloadDispatcherState::new(payload_db, tx_db, adapter);
    let dispatcher_entrypoint = PayloadDispatcherEntrypoint {
        inner: state.clone(),
    };

    let _payload_db_loader = tokio::spawn(async move {
        payload_iterator
            .load_from_db()
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

    let state = PayloadDispatcherState::new(payload_db, tx_db, adapter);
    let dispatcher_entrypoint = PayloadDispatcherEntrypoint {
        inner: state.clone(),
    };

    let _payload_db_loader = tokio::spawn(async move {
        payload_iterator
            .load_from_db()
            .await
            .expect("Payload loader crashed");
    });

    let payload_dispatcher = PayloadDispatcher {
        inner: state.clone(),
        domain: "dummy_destination".to_string(),
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
}
