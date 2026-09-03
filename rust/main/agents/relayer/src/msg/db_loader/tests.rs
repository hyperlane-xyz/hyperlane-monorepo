use std::time::Instant;

use prometheus::{HistogramVec, IntCounterVec, IntGaugeVec};
use tokio::{
    sync::mpsc::{self, Receiver},
    time::{sleep, timeout},
};
use tokio_metrics::TaskMonitor;
use tracing::info_span;

use hyperlane_base::{
    broadcast::IndexingNotification,
    cache::{LocalCache, MeteredCache, MeteredCacheConfig, MeteredCacheMetrics, OptionalCache},
    db::{test_utils, DbError, HyperlaneRocksDB},
    tests::mock_hyperlane_db::MockHyperlaneDb as MockDb,
};
use hyperlane_core::{
    test_utils::dummy_domain, PendingOperationResult, PendingOperationStatus, H512,
};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};

use crate::{
    db_loader::DbLoader,
    test_utils::dummy_data::{dummy_message_context, dummy_metadata_builder},
};

use super::*;

pub struct DummyApplicationOperationVerifier {}

fn notification(tx_id: H512) -> IndexingNotification {
    IndexingNotification::from_tx_id(tx_id)
}

fn only_operation(batch: QueueOperationBatch) -> QueueOperation {
    assert_eq!(batch.len(), 1);
    batch.into_iter().next().unwrap()
}

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
    index_notifications: Option<Receiver<IndexingNotification>>,
) -> (MessageDbLoader, Receiver<QueueOperationBatch>) {
    let base_metadata_builder =
        dummy_metadata_builder(origin_domain, destination_domain, db, cache.clone());
    let message_context = Arc::new(dummy_message_context(
        Arc::new(base_metadata_builder),
        db,
        cache,
    ));

    let (send_channel, receive_channel) = mpsc::channel::<QueueOperationBatch>(1);
    let mut loader = MessageDbLoader::new(
        db.clone(),
        Default::default(),
        Default::default(),
        Default::default(),
        dummy_message_loader_metrics(),
        HashMap::from([(destination_domain.id(), send_channel)]),
        HashMap::from([(destination_domain.id(), message_context)]),
        vec![].into(),
        DEFAULT_MAX_MESSAGE_RETRIES,
    )
    .unwrap();
    loader.set_index_notifications(index_notifications);
    (loader, receive_channel)
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

async fn finish_legacy_migration(loader: &mut MessageDbLoader) {
    while loader.migration_iterator.is_some() {
        loader.migrate_legacy_batch().await.unwrap();
        for iterator in &mut loader.destination_iterators {
            iterator.reconsider_nonces.clear();
        }
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
                .send(notification(H512::zero()))
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
                .try_send(notification(H512::from_low_u64_be(txid)))
                .expect("notification channel should have capacity");
        }
        let (mut loader, _) = dummy_message_loader_with_notifications(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
            Some(notification_receiver),
        );

        loader.drain_index_notifications().unwrap();

        assert_eq!(
            loader.index_notifications.as_ref().map(Receiver::len),
            Some(0)
        );
        notification_sender
            .try_send(notification(H512::from_low_u64_be(3)))
            .expect("draining should free channel capacity");
    })
    .await;
}

#[tokio::test]
async fn index_notification_reconsiders_only_its_destination() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let other_destination = dummy_domain(2, "other_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (mut loader, _) = dummy_message_loader(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
        );
        loader.destination_iterators[0].high_nonce = Some(100);
        loader.destination_iterators[0].low_nonce = None;
        let mut other = DestinationIndexIterator::new(other_destination.id(), Some(99));
        other.low_nonce = None;
        loader.destination_iterators.push(other);

        let late = dummy_hyperlane_message(&destination_domain, 95);
        add_db_entry(&db, &late, 0);
        loader
            .apply_index_notification(IndexingNotification {
                tx_id: H512::from_low_u64_be(95),
                sequences: vec![Some(95)],
            })
            .unwrap();

        assert!(loader.destination_iterators[0]
            .reconsider_nonces
            .contains(&95));
        assert!(loader.destination_iterators[1].reconsider_nonces.is_empty());
        assert!(!loader.destination_iterators[1].low_range_reopen_pending);
        assert_eq!(loader.destination_iterators[1].low_nonce, None);
    })
    .await;
}

#[tokio::test]
async fn index_notification_reopens_exhausted_low_range() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (notification_sender, notification_receiver) = mpsc::channel(1);
        let (mut loader, mut receiver) = dummy_message_loader_with_notifications(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
            Some(notification_receiver),
        );
        finish_legacy_migration(&mut loader).await;
        loader.destination_iterators[0].high_nonce = Some(6);
        loader.destination_iterators[0].low_nonce = None;

        let late = dummy_hyperlane_message(&destination_domain, 1);
        add_db_entry(&db, &late, 0);
        notification_sender
            .send(notification(H512::from_low_u64_be(1)))
            .await
            .expect("send index notification");

        loader.tick().await.expect("load late low nonce");

        assert_eq!(
            only_operation(receiver.try_recv().expect("late operation")).id(),
            late.id()
        );
    })
    .await;
}

#[tokio::test]
async fn index_notification_defers_reopen_until_active_low_range_exhausts() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (notification_sender, notification_receiver) = mpsc::channel(1);
        let (mut loader, mut receiver) = dummy_message_loader_with_notifications(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
            Some(notification_receiver),
        );
        finish_legacy_migration(&mut loader).await;
        loader.destination_iterators[0].high_nonce = Some(100);
        loader.destination_iterators[0].low_nonce = Some(89);

        let late = dummy_hyperlane_message(&destination_domain, 95);
        add_db_entry(&db, &late, 0);
        notification_sender
            .send(notification(H512::from_low_u64_be(95)))
            .await
            .expect("send index notification");
        loader.drain_index_notifications().unwrap();

        assert_eq!(loader.destination_iterators[0].low_nonce, Some(89));
        assert!(loader.destination_iterators[0].low_range_reopen_pending);

        loader.tick().await.expect("load late gap nonce");
        assert_eq!(
            only_operation(receiver.try_recv().expect("late operation")).id(),
            late.id()
        );
        assert!(!loader.destination_iterators[0].low_range_reopen_pending);
    })
    .await;
}

#[tokio::test]
async fn index_notification_reopens_after_active_low_range_reaches_zero() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (notification_sender, notification_receiver) = mpsc::channel(1);
        let (mut loader, mut receiver) = dummy_message_loader_with_notifications(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
            Some(notification_receiver),
        );
        finish_legacy_migration(&mut loader).await;
        loader.destination_iterators[0].high_nonce = Some(100);
        loader.destination_iterators[0].low_nonce = Some(0);

        let floor = dummy_hyperlane_message(&destination_domain, 0);
        let late = dummy_hyperlane_message(&destination_domain, 95);
        add_db_entry(&db, &floor, 0);
        add_db_entry(&db, &late, 0);
        notification_sender
            .send(notification(H512::from_low_u64_be(95)))
            .await
            .expect("send index notification");
        loader.drain_index_notifications().unwrap();

        loader.tick().await.expect("load low range floor");
        assert_eq!(
            only_operation(receiver.try_recv().expect("floor operation")).id(),
            floor.id()
        );
        assert!(loader.destination_iterators[0].low_nonce.is_none());
        assert!(loader.destination_iterators[0].low_range_reopen_pending);

        loader.tick().await.expect("load late gap nonce");
        assert_eq!(
            only_operation(receiver.try_recv().expect("late operation")).id(),
            late.id()
        );
        assert!(!loader.destination_iterators[0].low_range_reopen_pending);
    })
    .await;
}

#[test]
fn index_notification_reopens_low_range_after_max_nonce() {
    let mut iterator = DestinationIndexIterator::new(1, Some(u32::MAX));
    iterator.advance(IndexDirection::High, u32::MAX);
    iterator.low_nonce = None;

    iterator.request_low_range_reopen();

    assert_eq!(iterator.low_nonce, Some(u32::MAX));
}

#[tokio::test]
async fn waited_index_notification_reopens_exhausted_low_range() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (notification_sender, notification_receiver) = mpsc::channel(1);
        let (mut loader, mut receiver) = dummy_message_loader_with_notifications(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
            Some(notification_receiver),
        );
        finish_legacy_migration(&mut loader).await;
        loader.destination_iterators[0].high_nonce = Some(6);
        loader.destination_iterators[0].low_nonce = None;

        let late = dummy_hyperlane_message(&destination_domain, 1);
        let notify = async {
            sleep(Duration::from_millis(20)).await;
            add_db_entry(&db, &late, 0);
            notification_sender
                .send(notification(H512::from_low_u64_be(1)))
                .await
                .expect("send index notification");
        };

        timeout(Duration::from_millis(750), async {
            let (tick_result, _) = tokio::join!(loader.tick(), notify);
            tick_result.expect("notification should wake idle loader");
            loader.tick().await.expect("load late low nonce");
        })
        .await
        .expect("consumed notification should reopen low scan");

        assert_eq!(
            only_operation(receiver.try_recv().expect("late operation")).id(),
            late.id()
        );
    })
    .await;
}

#[tokio::test]
async fn reopened_low_range_does_not_duplicate_in_flight_message() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (notification_sender, notification_receiver) = mpsc::channel(1);
        let (mut loader, mut receiver) = dummy_message_loader_with_notifications(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
            Some(notification_receiver),
        );
        finish_legacy_migration(&mut loader).await;

        let high = dummy_hyperlane_message(&destination_domain, 5);
        add_db_entry(&db, &high, 0);
        loader.tick().await.expect("load high operation");
        let high_operation = only_operation(receiver.try_recv().expect("high operation"));
        assert_eq!(high_operation.id(), high.id());

        loader.destination_iterators[0].low_nonce = None;
        let late = dummy_hyperlane_message(&destination_domain, 1);
        add_db_entry(&db, &late, 0);
        notification_sender
            .send(notification(H512::from_low_u64_be(1)))
            .await
            .expect("send index notification");

        let late_operation = timeout(Duration::from_millis(750), async {
            loop {
                loader.tick().await.expect("scan reopened low range");
                if let Ok(batch) = receiver.try_recv() {
                    break only_operation(batch);
                }
            }
        })
        .await
        .expect("late operation should be found");
        assert_eq!(late_operation.id(), late.id());
        assert!(receiver.try_recv().is_err(), "high message was duplicated");

        drop(high_operation);
    })
    .await;
}

#[tokio::test]
async fn notification_after_terminal_drop_does_not_reload_message() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let (mut loader, receiver) = dummy_message_loader(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
        );
        finish_legacy_migration(&mut loader).await;

        let message = dummy_hyperlane_message(&destination_domain, 1);
        add_db_entry(&db, &message, 0);
        let guard = LoadedMessageGuard::try_acquire(
            message.id(),
            loader.destination_iterators[0].loaded_messages.clone(),
            db.clone(),
        )
        .expect("acquire loaded-message guard");
        let mut pending_message = PendingMessage::new(
            message.clone(),
            loader.destination_ctxs[&destination_domain.id()].clone(),
            PendingOperationStatus::FirstPrepareAttempt,
            None,
            DEFAULT_MAX_MESSAGE_RETRIES,
        );
        pending_message.set_loaded_message_guard(guard);
        assert!(matches!(
            pending_message.terminal_drop(),
            PendingOperationResult::Drop
        ));
        drop(pending_message);
        assert!(db
            .retrieve_terminally_dropped_message(&message.id())
            .unwrap());
        drop(loader);
        drop(receiver);

        let (notification_sender, notification_receiver) = mpsc::channel(1);
        let (mut restarted_loader, mut restarted_receiver) =
            dummy_message_loader_with_notifications(
                &origin_domain,
                &destination_domain,
                &db,
                OptionalCache::new(None),
                Some(notification_receiver),
            );
        finish_legacy_migration(&mut restarted_loader).await;
        assert!(restarted_loader.try_load_destination(0).await.unwrap());
        assert!(
            restarted_receiver.try_recv().is_err(),
            "terminal message was reloaded after restart"
        );
        assert_eq!(
            db.retrieve_pending_message_at_or_after(destination_domain.id(), message.nonce)
                .unwrap(),
            None,
            "terminal message index should be removed"
        );

        restarted_loader.destination_iterators[0].low_nonce = None;
        notification_sender
            .send(notification(H512::from_low_u64_be(1)))
            .await
            .expect("send index notification");
        restarted_loader.drain_index_notifications().unwrap();
        assert!(restarted_loader.try_load_destination(0).await.unwrap());
        assert!(
            restarted_receiver.try_recv().is_err(),
            "terminal message was reloaded"
        );

        let terminal_message_id = message.id();
        let mut replacement = message;
        replacement.body.push(1);
        db.upsert_message(&replacement, 0).unwrap();
        assert!(!db
            .retrieve_terminally_dropped_message(&terminal_message_id)
            .unwrap());
        restarted_loader.destination_iterators[0].low_nonce = None;
        notification_sender
            .send(notification(H512::from_low_u64_be(2)))
            .await
            .expect("send replacement notification");
        restarted_loader.drain_index_notifications().unwrap();
        assert!(restarted_loader.try_load_destination(0).await.unwrap());
        assert_eq!(
            only_operation(
                restarted_receiver
                    .try_recv()
                    .expect("replacement operation"),
            )
            .id(),
            replacement.id()
        );
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
        finish_legacy_migration(&mut loader).await;
        loader.try_load_destination(0).await.unwrap();

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
async fn mismatched_id_is_repaired_and_loaded_without_restart() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_domain = dummy_domain(1, "dummy_destination_domain");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        let message = dummy_hyperlane_message(&destination_domain, 0);
        add_db_entry(&db, &message, 0);

        let (mut loader, mut receiver) = dummy_message_loader(
            &origin_domain,
            &destination_domain,
            &db,
            OptionalCache::new(None),
        );
        finish_legacy_migration(&mut loader).await;

        let mut mismatched = message.clone();
        mismatched.body = vec![1];
        db.store_pending_message_index(&mismatched).unwrap();

        loader.try_load_destination(0).await.unwrap();
        assert!(receiver.try_recv().is_err());
        assert_eq!(
            db.retrieve_pending_message_at_or_after(destination_domain.id(), 0)
                .unwrap(),
            Some((message.nonce, message.id()))
        );

        loader.try_load_destination(0).await.unwrap();
        assert_eq!(
            only_operation(receiver.try_recv().unwrap()).id(),
            message.id()
        );
    })
    .await;
}

#[tokio::test]
async fn moved_message_reconsiders_target_without_restart() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination_a = dummy_domain(1, "destination_a");
        let destination_b = dummy_domain(3, "destination_b");
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
        let old = dummy_hyperlane_message(&destination_a, 0);
        add_db_entry(&db, &old, 0);
        let (sender_a, _receiver_a) = mpsc::channel::<QueueOperationBatch>(1);
        let (sender_b, mut receiver_b) = mpsc::channel::<QueueOperationBatch>(1);
        let mut loader = MessageDbLoader::new(
            db.clone(),
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
        )
        .unwrap();
        finish_legacy_migration(&mut loader).await;

        let mut moved = old.clone();
        moved.destination = destination_b.id();
        db.upsert_message(&moved, 1).unwrap();
        db.store_pending_message_index(&old).unwrap();
        let target_index = loader
            .destination_iterators
            .iter()
            .position(|iterator| iterator.destination == destination_b.id())
            .unwrap();
        loader.destination_iterators[target_index].high_nonce = Some(1);
        loader.destination_iterators[target_index].low_nonce = None;
        loader.destination_iterators[target_index]
            .reconsider_nonces
            .clear();
        let old_index = loader
            .destination_iterators
            .iter()
            .position(|iterator| iterator.destination == destination_a.id())
            .unwrap();

        loader.try_load_destination(old_index).await.unwrap();
        assert!(loader.destination_iterators[target_index]
            .reconsider_nonces
            .contains(&moved.nonce));
        loader.try_load_destination(target_index).await.unwrap();
        assert_eq!(
            only_operation(receiver_b.try_recv().unwrap()).id(),
            moved.id()
        );
    })
    .await;
}

#[tokio::test]
async fn alternating_cursor_does_not_starve_low_backlog() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination = dummy_domain(1, "destination");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        for nonce in 0..=4 {
            add_db_entry(&db, &dummy_hyperlane_message(&destination, nonce), 0);
        }
        let mut iterator = DestinationIndexIterator::new(destination.id(), Some(4));
        let metrics = dummy_message_loader_metrics();
        let mut directions = Vec::new();
        for new_high_nonce in 5..9 {
            let (direction, nonce, _) = iterator.peek(&db, &metrics).unwrap().unwrap();
            directions.push(direction);
            iterator.advance(direction, nonce);
            add_db_entry(
                &db,
                &dummy_hyperlane_message(&destination, new_high_nonce),
                0,
            );
        }
        assert_eq!(
            directions,
            vec![
                IndexDirection::High,
                IndexDirection::Low,
                IndexDirection::High,
                IndexDirection::Low,
            ]
        );
    })
    .await;
}

#[tokio::test]
async fn indexed_message_loads_before_large_legacy_backfill_finishes() {
    test_utils::run_test_db(|db| async move {
        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination = dummy_domain(1, "destination");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        for nonce in 0..64 {
            let message = dummy_hyperlane_message(&destination, nonce);
            add_db_entry(&db, &message, 0);
            db.delete_pending_message_index(&message).unwrap();
        }
        let indexed = dummy_hyperlane_message(&destination, 64);
        add_db_entry(&db, &indexed, 0);
        let (mut loader, mut receiver) =
            dummy_message_loader(&origin_domain, &destination, &db, OptionalCache::new(None));

        loader.tick().await.unwrap();

        assert!(loader.migration_iterator.is_some());
        assert_eq!(
            only_operation(receiver.try_recv().unwrap()).id(),
            indexed.id()
        );
        let newer = dummy_hyperlane_message(&destination, 65);
        add_db_entry(&db, &newer, 0);
        loader.tick().await.unwrap();
        loader.tick().await.unwrap();
        let next_ids = [
            only_operation(receiver.try_recv().unwrap()).id(),
            only_operation(receiver.try_recv().unwrap()).id(),
        ];
        assert!(next_ids.contains(&newer.id()));
        assert!(loader.migration_iterator.is_some());
        assert_eq!(
            db.retrieve_pending_message_at_or_before(destination.id(), 0)
                .unwrap(),
            None
        );
    })
    .await;
}

#[tokio::test]
async fn processed_legacy_history_does_not_rescan_every_destination() {
    test_utils::run_test_db(|db| async move {
        const HISTORY_LEN: u32 = 1_024;
        const DESTINATION_COUNT: u32 = 8;

        let origin_domain = dummy_domain(0, "dummy_origin_domain");
        let destination = dummy_domain(1, "destination");
        let db = HyperlaneRocksDB::new(&origin_domain, db);
        for nonce in 0..HISTORY_LEN {
            let message = dummy_hyperlane_message(&destination, nonce);
            add_db_entry(&db, &message, 0);
            db.store_message_processed(&message).unwrap();
        }

        let (mut loader, _receiver) =
            dummy_message_loader(&origin_domain, &destination, &db, OptionalCache::new(None));
        let mut _extra_receivers = Vec::new();
        for destination_id in 2..=DESTINATION_COUNT {
            let (sender, receiver) = mpsc::channel::<QueueOperationBatch>(1);
            loader.send_channels.insert(destination_id, sender);
            loader
                .destination_iterators
                .push(DestinationIndexIterator::new(
                    destination_id,
                    Some(HISTORY_LEN.saturating_sub(1)),
                ));
            _extra_receivers.push(receiver);
        }

        while loader.migration_iterator.is_some() {
            loader.tick().await.unwrap();
        }

        let destination_index_reads: u64 = loader
            .destination_iterators
            .iter()
            .map(|iterator| {
                loader
                    .metrics
                    .logical_db_reads
                    .with_label_values(&[
                        loader.metrics.origin.as_str(),
                        iterator.destination_label.as_ref(),
                        "destination_index",
                        "index",
                    ])
                    .get()
            })
            .sum();
        assert!(
            destination_index_reads <= u64::from(DESTINATION_COUNT).saturating_mul(2),
            "destination indexes were rescanned during legacy history migration"
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
        finish_legacy_migration(&mut loader).await;
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

        let (sender_a, mut receiver_a) = mpsc::channel::<QueueOperationBatch>(1);
        let (sender_b, mut receiver_b) = mpsc::channel::<QueueOperationBatch>(1);
        sender_a
            .try_send(vec![Box::new(PendingMessage::new(
                message_a.clone(),
                context_a.clone(),
                PendingOperationStatus::FirstPrepareAttempt,
                None,
                DEFAULT_MAX_MESSAGE_RETRIES,
            ))])
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
        )
        .unwrap();

        finish_legacy_migration(&mut loader).await;
        loader.tick().await.unwrap();

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

    let (mut iterator, watermark) = LegacyMessageIterator::new(db.clone()).unwrap();
    assert_eq!(watermark, Some(MOCK_HIGHEST_SEEN_NONCE));

    let mut messages = vec![];
    while !iterator.migration_complete() {
        if let Some(message) = iterator.try_get_next_message(&dummy_metrics).await.unwrap() {
            messages.push(message.nonce);
        }
    }

    // Migration crosses the missing nonce 1 but stops at the startup watermark.
    assert_eq!(messages, vec![2, 0]);

    assert_eq!(iterator.low_nonce_iter.nonce, None);
    assert_eq!(iterator.high_nonce_iter.nonce, None);
}

#[test]
fn startup_watermark_error_is_propagated() {
    let mut mock_db = MockDb::new();
    mock_db
        .expect_retrieve_highest_seen_message_nonce()
        .times(1)
        .returning(|| Err(DbError::Other("watermark read failed".to_owned())));

    assert!(LegacyMessageIterator::new(Arc::new(mock_db)).is_err());
}
