use std::time::Instant;

use prometheus::{HistogramVec, IntCounterVec, IntGaugeVec};
use tokio::{
    sync::mpsc::{self, Receiver},
    time::{sleep, timeout},
};
use tokio_metrics::TaskMonitor;
use tracing::info_span;

use hyperlane_base::{
    cache::{LocalCache, MeteredCache, MeteredCacheConfig, MeteredCacheMetrics, OptionalCache},
    db::{test_utils, HyperlaneRocksDB},
    tests::mock_hyperlane_db::MockHyperlaneDb as MockDb,
};
use hyperlane_core::{test_utils::dummy_domain, PendingOperationStatus};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};

use crate::{
    db_loader::DbLoader,
    test_utils::dummy_data::{dummy_message_context, dummy_metadata_builder},
};

use super::*;

pub struct DummyApplicationOperationVerifier {}

#[async_trait]
impl ApplicationOperationVerifier for DummyApplicationOperationVerifier {
    async fn verify(
        &self,
        _app_context: &Option<String>,
        _message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        None
    }
}

pub fn dummy_message_loader_metrics() -> MessageDbLoaderMetrics {
    MessageDbLoaderMetrics {
        last_known_message_nonce_gauge: IntGauge::new(
            "dummy_last_known_message_nonce_gauge",
            "help string",
        )
        .unwrap(),
        origin: "dummy_origin".to_owned(),
        records_examined: IntCounterVec::new(
            prometheus::Opts::new("dummy_db_loader_records_examined", "help string"),
            &["origin", "destination", "phase"],
        )
        .unwrap(),
        logical_db_reads: IntCounterVec::new(
            prometheus::Opts::new("dummy_db_loader_logical_reads", "help string"),
            &["origin", "destination", "phase", "operation"],
        )
        .unwrap(),
        scan_duration_seconds: HistogramVec::new(
            prometheus::HistogramOpts::new("dummy_db_loader_scan_duration", "help string"),
            &["origin", "destination", "phase"],
        )
        .unwrap(),
        ingress_depth: IntGaugeVec::new(
            prometheus::Opts::new("dummy_db_loader_ingress_depth", "help string"),
            &["destination"],
        )
        .unwrap(),
    }
}

pub fn dummy_cache_metrics() -> MeteredCacheMetrics {
    MeteredCacheMetrics {
        hit_count: IntCounterVec::new(
            prometheus::Opts::new("dummy_hit_count", "help string"),
            &["cache_name", "method", "status"],
        )
        .ok(),
        miss_count: IntCounterVec::new(
            prometheus::Opts::new("dummy_miss_count", "help string"),
            &["cache_name", "method", "status"],
        )
        .ok(),
    }
}

fn dummy_message_loader(
    origin_domain: &HyperlaneDomain,
    destination_domain: &HyperlaneDomain,
    db: &HyperlaneRocksDB,
    cache: OptionalCache<MeteredCache<LocalCache>>,
) -> (MessageDbLoader, Receiver<QueueOperationBatch>) {
    dummy_message_loader_with_notifications(origin_domain, destination_domain, db, cache, None)
}

fn dummy_message_loader_with_notifications(
    origin_domain: &HyperlaneDomain,
    destination_domain: &HyperlaneDomain,
    db: &HyperlaneRocksDB,
    cache: OptionalCache<MeteredCache<LocalCache>>,
    index_notifications: Option<Receiver<H512>>,
) -> (MessageDbLoader, Receiver<QueueOperationBatch>) {
    let base_metadata_builder =
        dummy_metadata_builder(origin_domain, destination_domain, db, cache.clone());
    let message_context = Arc::new(dummy_message_context(
        Arc::new(base_metadata_builder),
        db,
        cache,
    ));

    let (send_channel, receive_channel) = mpsc::channel::<QueueOperationBatch>(1);
    (
        MessageDbLoader::new(
            db.clone(),
            Default::default(),
            Default::default(),
            Default::default(),
            dummy_message_loader_metrics(),
            HashMap::from([(destination_domain.id(), send_channel)]),
            HashMap::from([(destination_domain.id(), message_context)]),
            vec![].into(),
            DEFAULT_MAX_MESSAGE_RETRIES,
            index_notifications,
        ),
        receive_channel,
    )
}

fn dummy_hyperlane_message(destination: &HyperlaneDomain, nonce: u32) -> HyperlaneMessage {
    HyperlaneMessage {
        version: Default::default(),
        nonce,
        // Origin must be different from the destination
        origin: destination.id() + 1,
        sender: Default::default(),
        destination: destination.id(),
        recipient: Default::default(),
        body: Default::default(),
    }
}

fn add_db_entry(db: &HyperlaneRocksDB, msg: &HyperlaneMessage, retry_count: u32) {
    db.store_message(msg, Default::default()).unwrap();
    if retry_count > 0 {
        db.store_pending_message_retry_count_by_message_id(&msg.id(), &retry_count)
            .unwrap();
    }
}

#[tokio::test]
async fn test_idle_tick_wakes_on_index_notification() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (notification_sender, notification_receiver) = mpsc::channel(1);
        let (mut loader, _) = dummy_message_loader_with_notifications(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
            Some(notification_receiver),
        );

        let notify = async move {
            sleep(Duration::from_millis(20)).await;
            notification_sender
                .send(H512::zero())
                .await
                .expect("notification receiver should remain open");
        };

        timeout(Duration::from_millis(750), async {
            let (tick_result, _) = tokio::join!(loader.tick(), notify);
            tick_result.expect("idle loader tick should succeed");
        })
        .await
        .expect("index notification should wake the idle loader promptly");
    })
    .await;
}

#[tokio::test]
async fn test_idle_tick_retains_polling_fallback() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (_notification_sender, notification_receiver) = mpsc::channel(1);
        let (mut loader, _) = dummy_message_loader_with_notifications(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
            Some(notification_receiver),
        );

        let start = Instant::now();
        timeout(Duration::from_millis(1_500), loader.tick())
            .await
            .expect("fallback poll should complete")
            .expect("idle loader tick should succeed");
        assert!(
            start.elapsed() >= Duration::from_millis(900),
            "idle loader woke before its fallback poll interval"
        );
    })
    .await;
}

#[tokio::test]
async fn test_idle_tick_returns_on_mid_wait_disconnect() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (notification_sender, notification_receiver) = mpsc::channel(1);
        let (mut loader, _) = dummy_message_loader_with_notifications(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
            Some(notification_receiver),
        );

        let disconnect = async move {
            sleep(Duration::from_millis(20)).await;
            drop(notification_sender);
        };

        timeout(Duration::from_millis(750), async {
            let (tick_result, _) = tokio::join!(loader.tick(), disconnect);
            tick_result.expect("idle loader tick should succeed");
        })
        .await
        .expect("receiver disconnect should wake the idle loader promptly");
        assert!(
            loader.index_notifications.is_none(),
            "disconnected receiver should be cleared"
        );
    })
    .await;
}

#[tokio::test]
async fn test_drain_index_notifications_clears_backlog() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (notification_sender, notification_receiver) = mpsc::channel(3);
        for txid in 0..3 {
            notification_sender
                .try_send(H512::from_low_u64_be(txid))
                .expect("notification channel should have capacity");
        }
        let (mut loader, _) = dummy_message_loader_with_notifications(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
            Some(notification_receiver),
        );

        loader.drain_index_notifications();

        assert_eq!(
            loader.index_notifications.as_ref().map(Receiver::len),
            Some(0)
        );
        notification_sender
            .try_send(H512::from_low_u64_be(3))
            .expect("draining should free channel capacity");
    })
    .await;
}

/// Only adds database entries to the pending message prefix if the message's
/// retry count is greater than zero
fn persist_retried_messages(
    retries: &[u32],
    db: &HyperlaneRocksDB,
    destination_domain: &HyperlaneDomain,
) {
    let mut nonce = 0;
    retries.iter().for_each(|num_retries| {
        let message = dummy_hyperlane_message(destination_domain, nonce);
        add_db_entry(db, &message, *num_retries);
        nonce += 1;
    });
}

/// Runs the db loader and returns the first `num_operations` to arrive on the
/// receiving end of the channel.
/// A default timeout is used for all `n` operations to arrive, otherwise the function panics.
async fn get_first_n_operations_from_db_loader(
    origin_domain: &HyperlaneDomain,
    destination_domain: &HyperlaneDomain,
    db: &HyperlaneRocksDB,
    cache: OptionalCache<MeteredCache<LocalCache>>,
    num_operations: usize,
) -> Vec<QueueOperation> {
    let (message_db_loader, mut receive_channel) =
        dummy_message_loader(origin_domain, destination_domain, db, cache);

    let db_loader = DbLoader::new(Box::new(message_db_loader), TaskMonitor::new());
    let load_fut = db_loader.spawn(info_span!("MessageDbLoader"));
    let mut pending_messages = vec![];
    let pending_message_accumulator = async {
        while let Some(batch) = receive_channel.recv().await {
            pending_messages.extend(batch);
            if pending_messages.len() == num_operations {
                break;
            }
        }
    };
    tokio::select! {
        _ = load_fut => {},
        _ = pending_message_accumulator => {},
        _ = sleep(Duration::from_millis(200)) => { panic!("No PendingMessage received from the db_loader") }
    };
    pending_messages
}

#[tokio::test]
async fn test_full_pending_message_persistence_flow() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let cache = OptionalCache::new(Some(MeteredCache::new(
            LocalCache::new("test-cache"),
            dummy_cache_metrics(),
            MeteredCacheConfig {
                cache_name: "test-cache".to_owned(),
            },
        )));

        // Assume the message syncer stored some new messages in HyperlaneDB
        let msg_retries = vec![0, 0, 0];
        persist_retried_messages(&msg_retries, &db, &destination_domain);

        // Run parser to load the messages in memory
        let pending_messages = get_first_n_operations_from_db_loader(
            &origin_domain,
            &destination_domain,
            &db,
            cache.clone(),
            msg_retries.len(),
        )
        .await;

        // Set some retry counts. This should update HyperlaneDB entries too.
        let msg_retries_to_set: [u32; 3] = [3, 0, 10];
        pending_messages
            .into_iter()
            .zip(msg_retries_to_set.into_iter())
            .for_each(|(mut pm, retry_count)| pm.set_retries(retry_count));

        // Run parser again
        let pending_messages = get_first_n_operations_from_db_loader(
            &origin_domain,
            &destination_domain,
            &db,
            cache.clone(),
            msg_retries.len(),
        )
        .await;

        // Expect the HyperlaneDB entry to have been updated, so the `OpQueue` in the submitter
        // can be accurately reconstructed on restart.
        // If the retry counts were correctly persisted, the backoffs will have the expected value.
        pending_messages
            .iter()
            .zip(msg_retries_to_set.iter())
            .for_each(|(pm, expected_retries)| {
                // Round up the actual backoff because it was calculated with an `Instant::now()` that was a fraction of a second ago
                let expected_backoff = PendingMessage::calculate_msg_backoff(
                    *expected_retries,
                    DEFAULT_MAX_MESSAGE_RETRIES,
                    None,
                    None,
                )
                .map(|b| b.as_secs_f32().round());
                let actual_backoff = pm
                    .next_attempt_after()
                    .map(|instant| instant.duration_since(Instant::now()).as_secs_f32().round());
                assert_eq!(expected_backoff, actual_backoff);
            });
    })
    .await;
}

#[tokio::test]
async fn legacy_records_are_reconciled_into_destination_index() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let message = dummy_hyperlane_message(&destination_domain, 0);
        add_db_entry(&db, &message, 0);
        db.delete_pending_message_index(&message).unwrap();

        let (mut loader, mut receiver) = dummy_message_loader(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
        );
        while loader.migration_iterator.is_some() {
            timeout(Duration::from_millis(200), loader.tick())
                .await
                .expect("migration tick should not wait for polling fallback")
                .unwrap();
        }

        assert_eq!(
            db.retrieve_pending_message_at_or_after(destination_domain.id(), 0)
                .unwrap(),
            Some((message.nonce, message.id()))
        );
        assert_eq!(
            receiver
                .try_recv()
                .unwrap()
                .into_iter()
                .next()
                .unwrap()
                .id(),
            message.id()
        );
    })
    .await;
}

#[tokio::test]
async fn stale_destination_index_entry_is_removed() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let stale_message = dummy_hyperlane_message(&destination_domain, 0);
        db.store_pending_message_index(&stale_message).unwrap();

        let (mut loader, _) = dummy_message_loader(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
        );
        timeout(Duration::from_millis(200), loader.tick())
            .await
            .expect("stale index cleanup should not wait for polling fallback")
            .unwrap();

        assert_eq!(
            db.retrieve_pending_message_at_or_after(destination_domain.id(), 0)
                .unwrap(),
            None
        );
    })
    .await;
}

#[tokio::test]
async fn closed_destination_channel_does_not_advance_index() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let message = dummy_hyperlane_message(&destination_domain, 0);
        add_db_entry(&db, &message, 0);

        let (mut loader, receiver) = dummy_message_loader(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
        );
        while loader.migrate_legacy_record().await.unwrap() {}
        drop(receiver);
        let cursor = loader.destination_iterators[0].high_nonce;

        assert!(loader.try_load_destination(0).await.is_err());
        assert_eq!(loader.destination_iterators[0].high_nonce, cursor);
        assert_eq!(
            db.retrieve_pending_message_at_or_after(destination_domain.id(), 0)
                .unwrap(),
            Some((message.nonce, message.id()))
        );
    })
    .await;
}

#[tokio::test]
async fn saturated_destination_does_not_block_another_destination() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_a = dummy_domain(1, "destination_a");
        let destination_b = dummy_domain(2, "destination_b");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let cache = OptionalCache::new(None);

        let context_a = Arc::new(dummy_message_context(
            Arc::new(dummy_metadata_builder(
                &origin_domain,
                &destination_a,
                &db,
                cache.clone(),
            )),
            &db,
            cache.clone(),
        ));
        let context_b = Arc::new(dummy_message_context(
            Arc::new(dummy_metadata_builder(
                &origin_domain,
                &destination_b,
                &db,
                cache,
            )),
            &db,
            OptionalCache::new(None),
        ));
        let message_a = dummy_hyperlane_message(&destination_a, 0);
        let message_b = dummy_hyperlane_message(&destination_b, 1);
        add_db_entry(&db, &message_a, 0);
        add_db_entry(&db, &message_b, 0);

        let (sender_a, mut receiver_a) = mpsc::channel::<QueueOperation>(1);
        let (sender_b, mut receiver_b) = mpsc::channel::<QueueOperation>(1);
        sender_a
            .try_send(Box::new(PendingMessage::new(
                message_a.clone(),
                context_a.clone(),
                PendingOperationStatus::FirstPrepareAttempt,
                None,
                DEFAULT_MAX_MESSAGE_RETRIES,
            )))
            .unwrap();
        let mut loader = MessageDbLoader::new(
            db,
            Default::default(),
            Default::default(),
            Default::default(),
            dummy_message_loader_metrics(),
            HashMap::from([
                (destination_a.id(), sender_a),
                (destination_b.id(), sender_b),
            ]),
            HashMap::from([
                (destination_a.id(), context_a),
                (destination_b.id(), context_b),
            ]),
            vec![].into(),
            DEFAULT_MAX_MESSAGE_RETRIES,
            None,
        );

        while loader.migration_iterator.is_some() {
            timeout(Duration::from_millis(200), loader.tick())
                .await
                .expect("migration tick should not wait for polling fallback")
                .unwrap();
        }

        assert_eq!(
            receiver_b
                .try_recv()
                .unwrap()
                .into_iter()
                .next()
                .unwrap()
                .id(),
            message_b.id()
        );
        assert_eq!(receiver_a.len(), 1);

        timeout(Duration::from_millis(750), async {
            let release_capacity = async {
                sleep(Duration::from_millis(20)).await;
                receiver_a.recv().await.unwrap();
            };
            let (tick_result, _) = tokio::join!(loader.tick(), release_capacity);
            tick_result.unwrap();
        })
        .await
        .expect("loader should wake when destination capacity becomes available");
    })
    .await;
}

#[tokio::test]
async fn legacy_iterator_stops_at_startup_watermark() {
    let mut mock_db = MockDb::new();
    const MOCK_HIGHEST_SEEN_NONCE: u32 = 2;

    mock_db
        .expect_domain()
        .return_const(dummy_domain(0, "dummy_domain"));
    mock_db
        .expect_retrieve_highest_seen_message_nonce()
        .returning(|| Ok(Some(MOCK_HIGHEST_SEEN_NONCE)));
    mock_db
        .expect_retrieve_message_by_nonce()
        .returning(move |nonce| {
            if nonce > MOCK_HIGHEST_SEEN_NONCE || nonce == 1 {
                Ok(None)
            } else {
                Ok(Some(dummy_hyperlane_message(
                    &dummy_domain(1, "dummy_domain"),
                    nonce,
                )))
            }
        });

    // The messages must be marked as "not processed" in the db for them to be returned
    // when the iterator queries them
    mock_db
        .expect_retrieve_processed_by_nonce()
        .returning(|_| Ok(Some(false)));
    let dummy_metrics = dummy_message_loader_metrics();
    let db = Arc::new(mock_db);

    let mut iterator = LegacyMessageIterator::new(db.clone());

    let mut messages = vec![];
    while let Some(msg) = iterator.try_get_next_message(&dummy_metrics).await.unwrap() {
        messages.push(msg.nonce);
    }

    // Migration crosses the missing nonce 1 but stops at the startup watermark.
    assert_eq!(messages, vec![2, 0]);

    assert_eq!(iterator.low_nonce_iter.nonce, None);
    assert_eq!(iterator.high_nonce_iter.nonce, None);
}
