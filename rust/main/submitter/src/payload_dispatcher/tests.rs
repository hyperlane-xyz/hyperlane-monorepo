use std::{collections::VecDeque, sync::Arc, time::Duration};

use tokio::{sync::Mutex, time::sleep};

use crate::{
    payload_dispatcher::{
        test_utils::{tmp_dbs, MockAdapter},
        BuildingStageQueue, PayloadDbLoader, PayloadDispatcherState,
    },
    Entrypoint, FullPayload, PayloadDispatcherEntrypoint,
};

#[tokio::test]
async fn test_payload_db_write_is_detected_by_loader() {
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
