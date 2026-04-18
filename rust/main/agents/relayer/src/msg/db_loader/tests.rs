use std::sync::Mutex;
use std::time::Instant;

use prometheus::IntCounterVec;
use tokio::{
    sync::mpsc::{self, UnboundedReceiver},
    time::sleep,
};
use tokio_metrics::TaskMonitor;
use tracing::info_span;

use hyperlane_base::{
    cache::{LocalCache, MeteredCache, MeteredCacheConfig, MeteredCacheMetrics, OptionalCache},
    db::{test_utils, HyperlaneRocksDB},
    tests::mock_hyperlane_db::MockHyperlaneDb as MockDb,
};
use hyperlane_core::test_utils::dummy_domain;
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
) -> (MessageDbLoader, UnboundedReceiver<QueueOperation>) {
    let base_metadata_builder =
        dummy_metadata_builder(origin_domain, destination_domain, db, cache.clone());
    let message_context = Arc::new(dummy_message_context(
        Arc::new(base_metadata_builder),
        db,
        cache,
    ));

    let (send_channel, receive_channel) = mpsc::unbounded_channel::<QueueOperation>();
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
        while let Some(pm) = receive_channel.recv().await {
            pending_messages.push(pm);
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
async fn test_forward_backward_iterator() {
    let mut mock_db = MockDb::new();
    const MAX_ONCHAIN_NONCE: u32 = 4;
    const MOCK_HIGHEST_SEEN_NONCE: u32 = 2;

    // How many times the db was queried for the max onchain nonce message
    let mut retrieve_calls_for_max_onchain_nonce = 0;

    mock_db
        .expect_domain()
        .return_const(dummy_domain(0, "dummy_domain"));
    mock_db
        .expect_retrieve_highest_seen_message_nonce()
        .returning(|| Ok(Some(MOCK_HIGHEST_SEEN_NONCE)));
    mock_db
        .expect_retrieve_message_by_nonce()
        .returning(move |nonce| {
            // return `None` the first time we get a query for the last message
            // (the `MAX_ONCHAIN_NONCE`th one), to simulate an ongoing indexing that hasn't finished
            if nonce == MAX_ONCHAIN_NONCE && retrieve_calls_for_max_onchain_nonce == 0 {
                retrieve_calls_for_max_onchain_nonce += 1;
                return Ok(None);
            }

            // otherwise return a message for every nonce in the closed
            // interval [0, MAX_ONCHAIN_NONCE]
            if nonce > MAX_ONCHAIN_NONCE {
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

    let mut forward_backward_iterator = ForwardBackwardIterator::new(db.clone());

    let mut messages = vec![];
    while let Some(msg) = forward_backward_iterator
        .try_get_next_message(&dummy_metrics)
        .await
        .unwrap()
    {
        messages.push(msg.nonce);
    }

    // we start with 2 (MOCK_HIGHEST_SEEN_NONCE) as the highest seen nonce,
    // so we go forward and get 3.
    // then we try going forward again but get a `None` (not indexed yet), for nonce 4 (MAX_ONCHAIN_NONCE).
    // then we go backwards once and get 1.
    // then retry the forward iteration, which should return a message the second time, for nonce 4.
    // finally, going forward again returns None so we go backward and get 0.
    assert_eq!(messages, vec![2, 3, 1, 4, 0]);

    // the final bounds of the iterator are (None, MAX_ONCHAIN_NONCE + 1), where None means
    // the backward iterator has reached the beginning (iterated past nonce 0)
    assert_eq!(forward_backward_iterator.low_nonce_iter.nonce, None);
    assert_eq!(
        forward_backward_iterator.high_nonce_iter.nonce,
        Some(MAX_ONCHAIN_NONCE + 1)
    );
}

/// Regression for the `MessageDbLoader` nonce-cache bug (SBP-371 / PRMX
/// Warp Route 2026-04-18): `ForwardBackwardIterator::new` reads
/// `retrieve_highest_seen_message_nonce` exactly once. When the relayer
/// starts against an empty DB (e.g. after a RocksDB wipe, or before the
/// first message for a direction has been indexed), the forward iterator is
/// pinned at `Some(0)` forever. Any messages `ContractSync` later writes to
/// the DB are never surfaced to the processor, even though they exist in
/// RocksDB and show up in `hyperlane_last_known_message_nonce`.
///
/// The fix in `refresh_from_db_if_lagging` re-reads the DB's highest nonce
/// when both iterators hit `Unindexed`, and jumps the forward (and, if it
/// would otherwise stay behind, backward) iterator forward.
///
/// This simulates the PRMX scenario where `index.from` cursored past low
/// nonces after a RocksDB wipe: the first message `ContractSync` actually
/// stores has nonce 5, not nonce 0. With the pre-fix behaviour the forward
/// iterator probes nonce 0 (not present → `Unindexed`) and the backward
/// iterator has `None` (→ `Unindexed`), so `try_get_next_message` returns
/// `None` indefinitely — that's what caused the 4+ hour stall on
/// 2026-04-18 and forced a `docker restart` to rebuild the iterator.
#[tokio::test]
async fn db_loader_jumps_to_new_high_nonce_after_empty_start() {
    let mut mock_db = MockDb::new();

    // Shared DB highest-seen-nonce state; flipped by the test body between
    // loader calls to simulate `ContractSync` writing a new message.
    let db_highest: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
    let db_highest_for_nonce = db_highest.clone();
    let db_highest_for_msgs = db_highest.clone();

    mock_db
        .expect_domain()
        .return_const(dummy_domain(0, "dummy_domain"));

    mock_db
        .expect_retrieve_highest_seen_message_nonce()
        .returning(move || Ok(*db_highest_for_nonce.lock().unwrap()));

    // Simulates `index.from` starting past low nonces: only the exact
    // highest-seen nonce is present in the DB. Nonces below it were never
    // indexed and will never be indexed (for this test).
    mock_db
        .expect_retrieve_message_by_nonce()
        .returning(move |nonce| {
            let highest = *db_highest_for_msgs.lock().unwrap();
            match highest {
                Some(h) if nonce == h => Ok(Some(dummy_hyperlane_message(
                    &dummy_domain(1, "dummy_domain"),
                    nonce,
                ))),
                _ => Ok(None),
            }
        });

    mock_db
        .expect_retrieve_processed_by_nonce()
        .returning(|_| Ok(Some(false)));

    let dummy_metrics = dummy_message_loader_metrics();
    let db = Arc::new(mock_db);

    let mut iter = ForwardBackwardIterator::new(db.clone());

    // Empty DB at construction: highest_seen is None, so the forward
    // iterator defaults to `Some(0)` via `unwrap_or_default`, and the
    // backward iterator at `None` (after one `iterate()` on the Low
    // direction with an initial `None`, which is a no-op).
    assert_eq!(iter.high_nonce_iter.nonce, Some(0));
    assert_eq!(iter.low_nonce_iter.nonce, None);

    // Nothing indexed yet → both iterators report `Unindexed`, the refresh
    // finds no new frontier (db_highest still None), loader correctly
    // returns None.
    let first = iter
        .try_get_next_message(&dummy_metrics)
        .await
        .expect("try_get_next_message should not error on empty DB");
    assert!(
        first.is_none(),
        "expected None when DB has no indexed messages"
    );

    // Simulate ContractSync indexing message with nonce 5 (and updating
    // highest_seen to 5) *after* the loader was constructed. Nonces 0..4
    // remain absent from the DB — this mirrors post-wipe `index.from`
    // behaviour where low nonces are skipped entirely.
    *db_highest.lock().unwrap() = Some(5);

    // Without `refresh_from_db_if_lagging`, this call stays at nonce 0
    // (probe returns None), the backward iterator is `None`, both hit
    // `Unindexed`, and the loader returns `None` forever until restart.
    // With the fix, the refresh detects the DB frontier has advanced to 5,
    // jumps the forward iterator to 5, finds the message, and returns it.
    let caught_up = iter
        .try_get_next_message(&dummy_metrics)
        .await
        .expect("try_get_next_message should not error after DB frontier advances")
        .expect("iterator must catch up to the DB's new highest nonce without a restart");
    assert_eq!(
        caught_up.nonce, 5,
        "expected the forward iterator to jump to the new DB frontier (nonce 5)"
    );

    // The forward iterator should have advanced past the delivered nonce
    // so the next tick probes nonce 6, not nonce 5 again.
    assert_eq!(iter.high_nonce_iter.nonce, Some(6));
    // The backward iterator should now be seeded just below the new
    // frontier so any gaps between the old (0) and new (5) positions can
    // still be picked up on subsequent ticks.
    assert_eq!(iter.low_nonce_iter.nonce, Some(4));
}
