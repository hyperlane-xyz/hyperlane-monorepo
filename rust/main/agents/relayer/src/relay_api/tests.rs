use std::collections::HashMap;
use std::ops::RangeInclusive;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use hyperlane_base::{
    cache::OptionalCache,
    db::{test_utils, HyperlaneRocksDB},
};
use hyperlane_core::{
    ChainResult, HyperlaneDomain, HyperlaneMessage, Indexed, Indexer, LogMeta, QueueOperation,
    H256, H512,
};
use hyperlane_test::mocks::MockMailboxContract;
use parking_lot::Mutex;
use prometheus::Registry;
use tempfile::TempDir;
use tokio::sync::{mpsc, RwLock};
use tower::ServiceExt;

use crate::msg::db_loader::tests::DummyApplicationOperationVerifier;
use crate::msg::gas_payment::GasPaymentEnforcer;
use crate::msg::pending_message::MessageContext;
use crate::relay_api::handlers::{RateLimiter, ServerState, TxHashCache};
use crate::relay_api::metrics::RelayApiMetrics;
use crate::settings::matching_list::MatchingList;
use crate::test_utils::{
    dummy_data::dummy_submission_metrics, mock_base_builder::build_mock_base_builder,
};

// ──────────────────────────────────────────────────────────────────────────────
// Constants used across every test
// ──────────────────────────────────────────────────────────────────────────────

const ORIGIN_ID: u32 = 1;
const DEST_ID: u32 = 2;
const TX_HASH: &str = "0xdeadbeef00000000000000000000000000000000000000000000000000000001";

// ──────────────────────────────────────────────────────────────────────────────
// MockIndexer
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct MockIndexer {
    messages: Vec<HyperlaneMessage>,
    is_cctp_v2_result: bool,
    delay: Option<Duration>,
}

impl MockIndexer {
    fn cctp(msg: HyperlaneMessage) -> Self {
        Self {
            messages: vec![msg],
            is_cctp_v2_result: true,
            delay: None,
        }
    }

    fn non_cctp(msg: HyperlaneMessage) -> Self {
        Self {
            messages: vec![msg],
            is_cctp_v2_result: false,
            delay: None,
        }
    }

    fn with_messages(msgs: Vec<HyperlaneMessage>) -> Self {
        Self {
            messages: msgs,
            is_cctp_v2_result: true,
            delay: None,
        }
    }

    fn with_delay(mut self, d: Duration) -> Self {
        self.delay = Some(d);
        self
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for MockIndexer {
    async fn fetch_logs_in_range(
        &self,
        _range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        Ok(vec![])
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(0)
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        _tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        if let Some(d) = self.delay {
            tokio::time::sleep(d).await;
        }
        Ok(self
            .messages
            .iter()
            .map(|m| (Indexed::new(m.clone()), LogMeta::default()))
            .collect())
    }

    async fn is_cctp_v2(&self, _tx_hash: H512) -> ChainResult<bool> {
        Ok(self.is_cctp_v2_result)
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Test scaffolding
// ──────────────────────────────────────────────────────────────────────────────

fn mock_mailbox() -> MockMailboxContract {
    let mut mock = MockMailboxContract::new();
    mock.expect__default_ism().returning(|| Ok(H256::zero()));
    // recipient_ism is called per-message in the handler with a 500ms timeout;
    // returning an ISM address of zero is sufficient for tests.
    mock.expect__recipient_ism().returning(|_| Ok(H256::zero()));
    mock
}

fn test_msg(origin: u32, destination: u32, nonce: u32) -> HyperlaneMessage {
    HyperlaneMessage {
        version: 3,
        nonce,
        origin,
        sender: H256::from_low_u64_be(1),
        destination,
        recipient: H256::from_low_u64_be(2),
        body: vec![],
    }
}

struct TestHarness {
    state: ServerState,
    rx: mpsc::UnboundedReceiver<QueueOperation>,
    _tempdir: TempDir,
}

async fn make_state(
    indexer: Arc<dyn Indexer<HyperlaneMessage>>,
    origin: u32,
    dest: u32,
) -> TestHarness {
    make_state_multi(indexer, origin, vec![dest]).await
}

async fn make_state_multi(
    indexer: Arc<dyn Indexer<HyperlaneMessage>>,
    origin: u32,
    dests: Vec<u32>,
) -> TestHarness {
    let tempdir = TempDir::new().unwrap();
    let db = test_utils::setup_db(tempdir.path().to_str().unwrap().to_owned());
    let domain = HyperlaneDomain::new_test_domain("relay_api_test");
    let rocks_db = HyperlaneRocksDB::new(&domain, db);

    let mock_builder = build_mock_base_builder(domain.clone(), domain.clone());
    let msg_ctx = MessageContext {
        destination_mailbox: Arc::new(mock_mailbox()),
        origin_db: Arc::new(rocks_db.clone()),
        cache: OptionalCache::new(None),
        metadata_builder: Arc::new(mock_builder),
        origin_gas_payment_enforcer: Arc::new(RwLock::new(GasPaymentEnforcer::new(
            [],
            rocks_db.clone(),
        ))),
        transaction_gas_limit: None,
        metrics: dummy_submission_metrics(),
        application_operation_verifier: Arc::new(DummyApplicationOperationVerifier {}),
    };
    let msg_ctx = Arc::new(msg_ctx);

    let mut indexers = HashMap::new();
    indexers.insert("ethereum".to_string(), indexer);

    let mut dbs = HashMap::new();
    dbs.insert(origin, rocks_db);

    let (tx, rx) = mpsc::unbounded_channel();
    let mut send_channels = HashMap::new();
    for &dest in &dests {
        send_channels.insert(dest, tx.clone());
    }

    let mut msg_ctxs = HashMap::new();
    for &dest in &dests {
        msg_ctxs.insert((origin, dest), msg_ctx.clone());
    }

    let metrics = RelayApiMetrics::new(&Registry::new()).unwrap();
    let state = ServerState::new(indexers, dbs, send_channels, msg_ctxs, metrics);

    TestHarness {
        state,
        rx,
        _tempdir: tempdir,
    }
}

fn relay_request(tx_hash: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/relay")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({
                "origin_chain": "ethereum",
                "tx_hash": tx_hash,
            })
            .to_string(),
        ))
        .unwrap()
}

async fn send_relay(router: axum::Router, tx_hash: &str) -> StatusCode {
    router
        .oneshot(relay_request(tx_hash))
        .await
        .unwrap()
        .status()
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_happy_path_enqueue() {
    let msg = test_msg(ORIGIN_ID, DEST_ID, 1);
    let TestHarness {
        state,
        mut rx,
        _tempdir,
    } = make_state(Arc::new(MockIndexer::cctp(msg)), ORIGIN_ID, DEST_ID).await;

    let cache = Arc::new(Mutex::new(TxHashCache::new(100)));
    let status = send_relay(state.with_tx_hash_cache(cache).router(), TX_HASH).await;

    assert_eq!(status, StatusCode::OK);
    assert!(rx.try_recv().is_ok(), "message should have been enqueued");
}

#[tokio::test]
async fn test_duplicate_within_ttl_rejected() {
    let msg = test_msg(ORIGIN_ID, DEST_ID, 1);
    let TestHarness {
        state,
        rx: _rx,
        _tempdir,
    } = make_state(Arc::new(MockIndexer::cctp(msg)), ORIGIN_ID, DEST_ID).await;

    let cache = Arc::new(Mutex::new(TxHashCache::new(100)));
    let router = state.with_tx_hash_cache(cache).router();

    let first = send_relay(router.clone(), TX_HASH).await;
    let second = send_relay(router.clone(), TX_HASH).await;

    assert_eq!(first, StatusCode::OK);
    assert_eq!(second, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn test_duplicate_after_ttl_allows_retry() {
    let msg = test_msg(ORIGIN_ID, DEST_ID, 1);
    let TestHarness {
        state,
        rx: _rx,
        _tempdir,
    } = make_state(Arc::new(MockIndexer::cctp(msg)), ORIGIN_ID, DEST_ID).await;

    // 1 ms TTL so the entry expires immediately
    let cache = Arc::new(Mutex::new(TxHashCache::new_with_ttl(
        100,
        Duration::from_millis(1),
    )));
    let router = state.with_tx_hash_cache(cache).router();

    let first = send_relay(router.clone(), TX_HASH).await;
    tokio::time::sleep(Duration::from_millis(5)).await; // wait for TTL to expire
    let second = send_relay(router.clone(), TX_HASH).await;

    assert_eq!(first, StatusCode::OK);
    assert_eq!(second, StatusCode::OK, "should succeed after TTL expires");
}

#[tokio::test]
async fn test_concurrent_same_tx_only_one_succeeds() {
    let msg = test_msg(ORIGIN_ID, DEST_ID, 1);
    let TestHarness {
        state,
        rx: _rx,
        _tempdir,
    } = make_state(Arc::new(MockIndexer::cctp(msg)), ORIGIN_ID, DEST_ID).await;

    let cache = Arc::new(Mutex::new(TxHashCache::new(100)));
    let router = state.with_tx_hash_cache(cache).router();

    // Fire both requests concurrently; exactly one must win the write-lock race.
    let (s1, s2) = tokio::join!(
        send_relay(router.clone(), TX_HASH),
        send_relay(router.clone(), TX_HASH),
    );

    let successes = [s1, s2].iter().filter(|&&s| s == StatusCode::OK).count();
    let duplicates = [s1, s2]
        .iter()
        .filter(|&&s| s == StatusCode::TOO_MANY_REQUESTS)
        .count();

    assert_eq!(successes, 1, "exactly one request should succeed");
    assert_eq!(duplicates, 1, "the other should be rejected as duplicate");
}

#[tokio::test]
async fn test_rate_limit_exhaustion() {
    let msg = test_msg(ORIGIN_ID, DEST_ID, 1);
    let TestHarness {
        state,
        rx: _rx,
        _tempdir,
    } = make_state(Arc::new(MockIndexer::cctp(msg)), ORIGIN_ID, DEST_ID).await;

    // Allow exactly 1 request per 60-second window
    let limiter = Arc::new(RwLock::new(RateLimiter::new(1, 60)));
    let router = state.with_rate_limiter(limiter).router();

    let first = send_relay(router.clone(), TX_HASH).await;
    let second = send_relay(
        router.clone(),
        "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
    )
    .await;

    assert_eq!(first, StatusCode::OK);
    assert_eq!(second, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn test_extraction_timeout() {
    let msg = test_msg(ORIGIN_ID, DEST_ID, 1);
    // Delay longer than the handler's 10-second extraction timeout
    let indexer = Arc::new(MockIndexer::cctp(msg).with_delay(Duration::from_secs(15)));
    let TestHarness {
        state,
        rx: _rx,
        _tempdir,
    } = make_state(indexer, ORIGIN_ID, DEST_ID).await;

    let status = send_relay(state.router(), TX_HASH).await;
    assert_eq!(status, StatusCode::REQUEST_TIMEOUT);
}

#[tokio::test]
async fn test_non_cctp_message_rejected() {
    let msg = test_msg(ORIGIN_ID, DEST_ID, 1);
    let TestHarness {
        state,
        rx,
        _tempdir,
    } = make_state(Arc::new(MockIndexer::non_cctp(msg)), ORIGIN_ID, DEST_ID).await;

    let status = send_relay(state.router(), TX_HASH).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        rx.is_closed() || rx.len() == 0,
        "nothing should be enqueued"
    );
}

#[tokio::test]
async fn test_blacklisted_message_rejected() {
    let msg = test_msg(ORIGIN_ID, DEST_ID, 1);
    let TestHarness {
        state,
        rx,
        _tempdir,
    } = make_state(Arc::new(MockIndexer::cctp(msg)), ORIGIN_ID, DEST_ID).await;

    // Blacklist that matches our test message's destination domain
    let blacklist = Arc::new(MatchingList::with_destination_domain(DEST_ID));
    let status = send_relay(state.with_message_blacklist(blacklist).router(), TX_HASH).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(rx.len(), 0, "nothing should be enqueued");
}

#[tokio::test]
async fn test_non_whitelisted_message_rejected() {
    let msg = test_msg(ORIGIN_ID, DEST_ID, 1);
    let TestHarness {
        state,
        rx,
        _tempdir,
    } = make_state(Arc::new(MockIndexer::cctp(msg)), ORIGIN_ID, DEST_ID).await;

    // Whitelist that matches only destination domain 999 — our message (dest=2) won't match
    let whitelist = Arc::new(MatchingList::with_destination_domain(999));
    let status = send_relay(state.with_message_whitelist(whitelist).router(), TX_HASH).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(rx.len(), 0, "nothing should be enqueued");
}

#[tokio::test]
async fn test_cache_full_returns_503_before_any_sends() {
    let msg = test_msg(ORIGIN_ID, DEST_ID, 1);
    let TestHarness {
        state,
        mut rx,
        _tempdir,
    } = make_state(Arc::new(MockIndexer::cctp(msg)), ORIGIN_ID, DEST_ID).await;

    // Cache that holds exactly 1 entry
    let cache = Arc::new(Mutex::new(TxHashCache::new(1)));
    let router = state.with_tx_hash_cache(cache).router();

    // First request fills the cache
    let first = send_relay(router.clone(), TX_HASH).await;
    assert_eq!(first, StatusCode::OK);
    assert!(rx.try_recv().is_ok());

    // Second request with a different hash hits CacheFull — nothing should be sent
    let second = send_relay(
        router.clone(),
        "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
    )
    .await;
    assert_eq!(second, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(rx.len(), 0, "nothing should be enqueued when cache is full");
}

#[tokio::test]
async fn test_partial_send_failure_releases_dedup_for_retry() {
    let dest_a: u32 = DEST_ID;
    let dest_b: u32 = DEST_ID + 1;
    let msgs = vec![
        test_msg(ORIGIN_ID, dest_a, 1),
        test_msg(ORIGIN_ID, dest_b, 2),
    ];
    let indexer = Arc::new(MockIndexer::with_messages(msgs));

    // Build state with 2 destinations
    let TestHarness {
        state: _,
        rx: _rx_a,
        _tempdir,
    } = make_state_multi(indexer.clone(), ORIGIN_ID, vec![dest_a, dest_b]).await;

    // Pull dest_b's channel sender from the state and immediately drop the receiver
    // so send() returns Err. We achieve this by not including dest_b in the harness
    // and building a separate state where dest_b's channel is pre-closed.
    let tempdir2 = TempDir::new().unwrap();
    let db2 = test_utils::setup_db(tempdir2.path().to_str().unwrap().to_owned());
    let domain = HyperlaneDomain::new_test_domain("relay_api_test2");
    let rocks_db2 = HyperlaneRocksDB::new(&domain, db2);
    let mock_builder = build_mock_base_builder(domain.clone(), domain.clone());
    let msg_ctx = Arc::new(MessageContext {
        destination_mailbox: Arc::new(mock_mailbox()),
        origin_db: Arc::new(rocks_db2.clone()),
        cache: OptionalCache::new(None),
        metadata_builder: Arc::new(mock_builder),
        origin_gas_payment_enforcer: Arc::new(RwLock::new(GasPaymentEnforcer::new(
            [],
            rocks_db2.clone(),
        ))),
        transaction_gas_limit: None,
        metrics: dummy_submission_metrics(),
        application_operation_verifier: Arc::new(DummyApplicationOperationVerifier {}),
    });

    let (tx_a, _rx_a2) = mpsc::unbounded_channel::<QueueOperation>();
    // dest_b sender: drop the receiver immediately so sends fail
    let (tx_b, rx_b_dropped) = mpsc::unbounded_channel::<QueueOperation>();
    drop(rx_b_dropped);

    let mut indexers = HashMap::new();
    indexers.insert(
        "ethereum".to_string(),
        indexer as Arc<dyn Indexer<HyperlaneMessage>>,
    );
    let mut dbs = HashMap::new();
    dbs.insert(ORIGIN_ID, rocks_db2);
    let mut send_channels = HashMap::new();
    send_channels.insert(dest_a, tx_a);
    send_channels.insert(dest_b, tx_b);
    let mut msg_ctxs = HashMap::new();
    msg_ctxs.insert((ORIGIN_ID, dest_a), msg_ctx.clone());
    msg_ctxs.insert((ORIGIN_ID, dest_b), msg_ctx.clone());

    let metrics = RelayApiMetrics::new(&Registry::new()).unwrap();
    let state = ServerState::new(indexers, dbs, send_channels, msg_ctxs, metrics);

    let cache = Arc::new(Mutex::new(TxHashCache::new(100)));
    let router = state.with_tx_hash_cache(cache).router();

    // First call: dest_b send fails → 500, reservation released
    let first = send_relay(router.clone(), TX_HASH).await;
    assert_eq!(
        first,
        StatusCode::INTERNAL_SERVER_ERROR,
        "partial send failure should return 500"
    );

    // Same tx_hash again: should not be 429 — dedup was released
    let second = send_relay(router.clone(), TX_HASH).await;
    assert_ne!(
        second,
        StatusCode::TOO_MANY_REQUESTS,
        "after 500, same tx_hash must not be blocked by dedup cache"
    );
}
