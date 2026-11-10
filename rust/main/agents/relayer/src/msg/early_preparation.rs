//! Bounded, disposable read-ahead. Only normal confirmed ingestion can enqueue a
//! message. These tasks populate the existing RPC cache; they never fetch a
//! signature, build delivery metadata, or write origin events.
//!
//! Zero-depth dispatch -> cached recipient / ISM / validator discovery.
//! Configured-depth dispatch -> wake the ordinary confirmed message loader.
//! Block notifications refresh aged discovery; they never authorize delivery.
//! Rollback/disconnect only abort read-ahead. The existing durable reorg gates
//! still protect canonical queues, Merkle proofs, and submission.
//! Cache keys, policies and expiry are shared with normal preparation; completed
//! RPC results remain usable after cancellation because they contain no early
//! origin state. Empty announcements and negative recipient reads are not cached.
//! Current delivery/payment checks, checkpoint reorg checks, signature validation
//! and process simulation remain on the normal confirmed path.

use std::{collections::HashMap, sync::Arc, time::Duration};

use eyre::Result;
use hyperlane_base::cache::FunctionCallCache;
use hyperlane_core::{HyperlaneMessage, H256};
use parking_lot::Mutex;
use tokio::{
    sync::{Notify, Semaphore},
    task::JoinHandle,
    time::Instant,
};
use tracing::{debug, info, warn};

use super::{
    blacklist::AddressBlacklist, metadata::MessageMetadataBuilder, pending_message::MessageContext,
};
use crate::settings::matching_list::MatchingList;

const MAX_MESSAGES: usize = 256;
const MAX_CONCURRENT: usize = 8;
const MAX_AGE: Duration = Duration::from_secs(30 * 60);
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const REFRESH_INTERVAL: Duration = Duration::from_secs(30);

struct Preparation {
    message: Arc<HyperlaneMessage>,
    context: Arc<MessageContext>,
    discovered: Instant,
    last_started: Instant,
    task: JoinHandle<()>,
}

impl Drop for Preparation {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(crate) struct EarlyPreparation {
    contexts: HashMap<(u32, u32), Arc<MessageContext>>,
    notifications: HashMap<u32, Arc<Notify>>,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    address_blacklist: Arc<AddressBlacklist>,
    messages: Mutex<HashMap<H256, Preparation>>,
    permits: Arc<Semaphore>,
}

impl EarlyPreparation {
    pub(crate) fn new(
        contexts: HashMap<(u32, u32), Arc<MessageContext>>,
        whitelist: Arc<MatchingList>,
        blacklist: Arc<MatchingList>,
        address_blacklist: Arc<AddressBlacklist>,
    ) -> Self {
        let notifications = contexts
            .keys()
            .map(|(origin, _)| (*origin, Arc::new(Notify::new())))
            .collect();
        Self {
            notifications,
            contexts,
            whitelist,
            blacklist,
            address_blacklist,
            messages: Mutex::default(),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT)),
        }
    }

    pub(crate) fn discover(&self, message: HyperlaneMessage) {
        if !self.whitelist.msg_matches(&message, true)
            || self.blacklist.msg_matches(&message, false)
            || self
                .address_blacklist
                .find_blacklisted_address(&message)
                .is_some()
        {
            return;
        }
        let Some(context) = self.contexts.get(&(message.origin, message.destination)) else {
            return;
        };
        if !needs_preparation(context, &message) {
            return;
        }
        let mut messages = self.messages.lock();
        messages.retain(|_, entry| entry.discovered.elapsed() < MAX_AGE);
        let id = message.id();
        if messages.contains_key(&id) {
            return;
        }
        if messages.len() >= MAX_MESSAGES {
            return;
        }
        let message = Arc::new(message);
        let Some(task) = self.spawn(context.clone(), message.clone()) else {
            return;
        };
        let now = Instant::now();
        info!(message_id = ?id, origin = message.origin,
            observed_at_millis = chrono::Utc::now().timestamp_millis(), "Early message discovered");
        messages.insert(
            id,
            Preparation {
                message,
                context: context.clone(),
                discovered: now,
                last_started: now,
                task,
            },
        );
    }

    /// Driven by streamed heads, never a polling loop. Cache TTLs remain unchanged:
    /// expired reads refresh through the same cache policy as normal preparation.
    pub(crate) fn refresh(&self, domain: u32) {
        let mut messages = self.messages.lock();
        messages.retain(|_, entry| {
            entry.discovered.elapsed() < MAX_AGE
                && (entry.message.origin != domain
                    || needs_preparation(&entry.context, &entry.message))
        });
        for entry in messages
            .values_mut()
            .filter(|entry| entry.message.origin == domain)
        {
            if !entry.task.is_finished() || entry.last_started.elapsed() < REFRESH_INTERVAL {
                continue;
            }
            if let Some(task) = self.spawn(entry.context.clone(), entry.message.clone()) {
                entry.task = task;
                entry.last_started = Instant::now();
            }
        }
    }

    /// This is only a cache handoff notification, never authorization to submit.
    pub(crate) fn confirmed(&self, message: &HyperlaneMessage) {
        if let Some(notification) = self.notifications.get(&message.origin) {
            notification.notify_one();
        }
        if let Some(entry) = self.messages.lock().remove(&message.id()) {
            info!(message_id = ?message.id(), origin = message.origin,
                elapsed_ms = entry.discovered.elapsed().as_millis() as u64,
                preparation_finished = entry.task.is_finished(),
                observed_at_millis = chrono::Utc::now().timestamp_millis(),
                "Early message confirmed; normal preparation owns delivery");
        }
    }

    pub(crate) fn notification(&self, domain: u32) -> Option<Arc<Notify>> {
        self.notifications.get(&domain).cloned()
    }

    /// Read-ahead is disposable: cancel the origin rather than track block ancestry.
    pub(crate) fn invalidate(&self, domain: u32) {
        self.messages
            .lock()
            .retain(|_, entry| entry.message.origin != domain);
    }

    fn spawn(
        &self,
        context: Arc<MessageContext>,
        message: Arc<HyperlaneMessage>,
    ) -> Option<JoinHandle<()>> {
        let permit = self.permits.clone().try_acquire_owned().ok()?;
        Some(tokio::spawn(async move {
            let _permit = permit;
            let started = Instant::now();
            match tokio::time::timeout(READ_TIMEOUT, prepare(&context, &message)).await {
                Ok(Ok(())) => info!(message_id = ?message.id(), origin = message.origin,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    observed_at_millis = chrono::Utc::now().timestamp_millis(), "Early preparation completed"),
                Ok(Err(error)) => debug!(message_id = ?message.id(), ?error,
                    "Early preparation failed; confirmed processing will retry"),
                Err(_) => warn!(message_id = ?message.id(), "Early preparation timed out"),
            }
        }))
    }
}

// RPC indexing can win the race with websocket confirmation. Do not keep
// refreshing a message that normal ingestion already owns.
fn needs_preparation(context: &MessageContext, message: &HyperlaneMessage) -> bool {
    match context.origin_db.retrieve_message_by_id(&message.id()) {
        Ok(None) => true,
        Ok(Some(_)) => false,
        Err(error) => {
            debug!(message_id = ?message.id(), ?error, "Skipping early preparation after origin DB read failed");
            false
        }
    }
}

async fn prepare(context: &MessageContext, message: &HyperlaneMessage) -> Result<()> {
    let mailbox = &context.destination_mailbox;
    let domain = mailbox.domain().name();
    let is_contract = match context
        .cache
        .get_cached_call_result::<bool>(domain, "is_contract", &message.recipient)
        .await?
    {
        Some(value) => value,
        None => {
            let value = mailbox.provider().is_contract(&message.recipient).await?;
            // Absence is provisional. Do not cache it or warm a fallback ISM
            // for a recipient that may be deployed before confirmation.
            if value {
                context
                    .cache
                    .cache_call_result(domain, "is_contract", &message.recipient, &value)
                    .await?;
            }
            value
        }
    };
    if !is_contract {
        return Ok(());
    }
    let root = context.recipient_ism(message.recipient).await?;
    MessageMetadataBuilder::new(context.metadata_builder.clone(), root, message)
        .await?
        .prepare(message)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::{
        dummy_data::dummy_message_context,
        mock_base_builder::{build_mock_base_builder, MockBaseMetadataBuilder},
        mock_ism::MockInterchainSecurityModule,
        mock_routing_ism::MockRoutingIsm,
    };
    use hyperlane_base::{
        cache::{
            LocalCache, MeteredCache, MeteredCacheConfig, MeteredCacheMetricsBuilder, OptionalCache,
        },
        db::{HyperlaneDb, HyperlaneRocksDB, DB},
    };
    use hyperlane_core::{HyperlaneDomain, ModuleType};
    use hyperlane_test::mocks::MockMailboxContract;

    struct Fixture {
        _dir: tempfile::TempDir,
        context: Arc<MessageContext>,
        base: Arc<MockBaseMetadataBuilder>,
        db: HyperlaneRocksDB,
        message: HyperlaneMessage,
    }

    impl Fixture {
        async fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let domain = HyperlaneDomain::new_test_domain("test1");
            let db = HyperlaneRocksDB::new(&domain, DB::from_path(dir.path()).unwrap());
            let cache = OptionalCache::new(Some(MeteredCache::new(
                LocalCache::new("early-tests"),
                MeteredCacheMetricsBuilder::default().build().unwrap(),
                MeteredCacheConfig {
                    cache_name: "early-tests".into(),
                },
            )));
            let root = H256::from_low_u64_be(10);
            let leaf = H256::from_low_u64_be(11);
            let mut base = build_mock_base_builder(domain.clone(), domain.clone());
            base.responses.cache = Some(cache.clone());
            for attempt in 0..4 {
                base.responses.push_build_ism_response(
                    root,
                    Ok(Box::new(MockInterchainSecurityModule::new(
                        root,
                        domain.clone(),
                        ModuleType::Routing,
                    ))),
                );
                base.responses.push_build_ism_response(
                    leaf,
                    Ok(Box::new(MockInterchainSecurityModule::new(
                        leaf,
                        domain.clone(),
                        ModuleType::Null,
                    ))),
                );
                let routing = MockRoutingIsm::new(root, domain.clone());
                // A second route() call would fail: checked delivery must reuse
                // the result obtained through the real preparation/cache path.
                if attempt == 0 {
                    routing.responses.route.lock().unwrap().push_back(Ok(leaf));
                }
                base.responses
                    .push_build_routing_ism_response(root, Ok(Box::new(routing)));
            }
            let base = Arc::new(base);
            let mut context = dummy_message_context(base.clone(), &db, cache.clone());
            let mut mailbox = MockMailboxContract::new_with_default_ism(H256::zero());
            mailbox.expect__domain().return_const(domain.clone());
            mailbox.expect__recipient_ism().returning(move |_| Ok(root));
            context.destination_mailbox = Arc::new(mailbox);
            let message = HyperlaneMessage {
                version: 3,
                origin: domain.id(),
                destination: domain.id(),
                nonce: 0,
                sender: H256::from_low_u64_be(1),
                recipient: H256::from_low_u64_be(2),
                body: vec![1],
            };
            cache
                .cache_call_result(domain.name(), "is_contract", &message.recipient, &true)
                .await
                .unwrap();
            Self {
                _dir: dir,
                context: Arc::new(context),
                base,
                db,
                message,
            }
        }

        fn preparer(&self) -> EarlyPreparation {
            EarlyPreparation::new(
                HashMap::from([(
                    (self.message.origin, self.message.destination),
                    self.context.clone(),
                )]),
                Default::default(),
                Default::default(),
                Arc::new(AddressBlacklist::new(vec![])),
            )
        }

        async fn cached<T: serde::de::DeserializeOwned>(
            &self,
            method: &str,
            params: &(impl serde::Serialize + Send + Sync),
        ) -> Option<T> {
            self.context
                .cache
                .get_cached_call_result(
                    self.context.destination_mailbox.domain().name(),
                    method,
                    params,
                )
                .await
                .unwrap()
        }
    }

    #[tokio::test]
    async fn missing_recipient_does_not_preload_a_fallback_ism() {
        let fixture = Fixture::new().await;
        let domain = fixture.context.destination_mailbox.domain();
        fixture
            .context
            .cache
            .cache_call_result(
                domain.name(),
                "is_contract",
                &fixture.message.recipient,
                &false,
            )
            .await
            .unwrap();
        prepare(&fixture.context, &fixture.message).await.unwrap();
        assert_eq!(
            fixture
                .cached::<H256>("recipient_ism", &fixture.message.recipient)
                .await,
            None
        );
        fixture
            .context
            .cache
            .cache_call_result(
                domain.name(),
                "is_contract",
                &fixture.message.recipient,
                &true,
            )
            .await
            .unwrap();
        prepare(&fixture.context, &fixture.message).await.unwrap();
        assert_eq!(
            fixture
                .cached::<H256>("recipient_ism", &fixture.message.recipient)
                .await,
            Some(H256::from_low_u64_be(10))
        );
    }

    #[tokio::test]
    async fn early_rpc_results_are_reused_by_checked_build_without_origin_writes() {
        let fixture = Fixture::new().await;
        prepare(&fixture.context, &fixture.message).await.unwrap();
        assert!(fixture
            .db
            .retrieve_message_by_id(&fixture.message.id())
            .unwrap()
            .is_none());
        assert!(fixture
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&0)
            .unwrap()
            .is_none());
        assert!(fixture.base.requests.activities.lock().unwrap().is_empty());
        assert!(fixture
            .base
            .requests
            .checkpoint_reorg_checks
            .lock()
            .unwrap()
            .is_empty());
        let builder = MessageMetadataBuilder::new(
            fixture.base.clone(),
            H256::from_low_u64_be(10),
            &fixture.message,
        )
        .await
        .unwrap();
        builder
            .build_for_delivery(builder.root_ism, &fixture.message, false)
            .await
            .unwrap();
        assert!(!fixture.base.requests.activities.lock().unwrap().is_empty());
    }

    #[derive(Debug)]
    struct TestMultisig(hyperlane_core::HyperlaneDomain, H256);
    impl hyperlane_core::HyperlaneChain for TestMultisig {
        fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
            &self.0
        }
        fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
            unreachable!("no provider reads")
        }
    }
    impl hyperlane_core::HyperlaneContract for TestMultisig {
        fn address(&self) -> H256 {
            self.1
        }
    }
    #[async_trait::async_trait]
    impl hyperlane_core::MultisigIsm for TestMultisig {
        async fn validators_and_threshold(
            &self,
            _: &HyperlaneMessage,
        ) -> hyperlane_core::ChainResult<(Vec<H256>, u8)> {
            Ok((vec![H256::from_low_u64_be(1), H256::from_low_u64_be(2)], 2))
        }
    }

    #[tokio::test]
    async fn multisig_preparation_resolves_validators_without_fetching_checkpoints() {
        let fixture = Fixture::new().await;
        let domain = fixture.context.destination_mailbox.domain().clone();
        let root = H256::from_low_u64_be(10);
        fixture
            .base
            .responses
            .build_ism
            .lock()
            .unwrap()
            .get_mut(&root)
            .unwrap()
            .clear();
        fixture.base.responses.push_build_ism_response(
            root,
            Ok(Box::new(MockInterchainSecurityModule::new(
                root,
                domain.clone(),
                ModuleType::MessageIdMultisig,
            ))),
        );
        fixture
            .base
            .responses
            .build_multisig_ism
            .lock()
            .unwrap()
            .push_back(Ok(Box::new(TestMultisig(domain.clone(), root))));
        prepare(&fixture.context, &fixture.message).await.unwrap();
        let cached = fixture
            .cached::<(Vec<H256>, u8)>("validators_and_threshold", &(root, fixture.message.id()))
            .await
            .unwrap();
        assert_eq!(cached.1, 2);
        assert_eq!(cached.0.len(), 2);
        assert!(fixture
            .base
            .requests
            .checkpoint_reorg_checks
            .lock()
            .unwrap()
            .is_empty());
        assert!(fixture.base.requests.activities.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn checked_build_refreshes_expired_preparation_instead_of_freezing_the_route() {
        let fixture = Fixture::new().await;
        let domain = fixture.context.destination_mailbox.domain().clone();
        let root = H256::from_low_u64_be(10);
        let key = (root, fixture.message.id());
        fixture
            .context
            .cache
            .cache_call_result_with_expiration(
                domain.name(),
                "route",
                &key,
                &H256::from_low_u64_be(11),
                hyperlane_base::cache::ExpirationType::AfterDuration(Duration::from_secs(1)),
            )
            .await
            .unwrap();
        prepare(&fixture.context, &fixture.message).await.unwrap();
        let replacement = H256::from_low_u64_be(12);
        let routing = MockRoutingIsm::new(root, domain.clone());
        routing
            .responses
            .route
            .lock()
            .unwrap()
            .push_back(Ok(replacement));
        fixture
            .base
            .responses
            .build_routing_ism
            .lock()
            .unwrap()
            .get_mut(&root)
            .unwrap()
            .push_front(Ok(Box::new(routing)));
        fixture.base.responses.push_build_ism_response(
            replacement,
            Ok(Box::new(MockInterchainSecurityModule::new(
                replacement,
                domain.clone(),
                ModuleType::Null,
            ))),
        );
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let builder = MessageMetadataBuilder::new(fixture.base.clone(), root, &fixture.message)
            .await
            .unwrap();
        builder
            .build_for_delivery(root, &fixture.message, false)
            .await
            .unwrap();
        assert_eq!(
            fixture.cached::<H256>("route", &key).await,
            Some(replacement)
        );
    }

    #[tokio::test]
    async fn duplicate_hints_coalesce_and_rollback_cancels_only_the_origin() {
        let fixture = Fixture::new().await;
        let preparation = fixture.preparer();
        preparation.discover(fixture.message.clone());
        preparation.discover(fixture.message.clone());
        assert_eq!(preparation.messages.lock().len(), 1);
        preparation.invalidate(fixture.message.origin + 1);
        assert_eq!(preparation.messages.lock().len(), 1);
        preparation.invalidate(fixture.message.origin);
        assert!(preparation.messages.lock().is_empty());
        preparation.discover(fixture.message.clone());
        assert_eq!(preparation.messages.lock().len(), 1);
        preparation.confirmed(&fixture.message);
        assert!(preparation.messages.lock().is_empty());
        tokio::time::timeout(
            Duration::from_millis(100),
            preparation
                .notification(fixture.message.origin)
                .unwrap()
                .notified(),
        )
        .await
        .unwrap();
        assert!(fixture
            .db
            .retrieve_message_by_id(&fixture.message.id())
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn rpc_ingestion_retires_preparation_and_late_early_events_are_ignored() {
        let fixture = Fixture::new().await;
        let preparation = fixture.preparer();
        preparation.discover(fixture.message.clone());
        fixture.db.store_message(&fixture.message, 100).unwrap();
        preparation.refresh(fixture.message.origin);
        assert!(preparation.messages.lock().is_empty());
        preparation.discover(fixture.message.clone());
        assert!(preparation.messages.lock().is_empty());
    }

    #[tokio::test]
    async fn admission_is_bounded_and_does_not_queue_unlimited_rpc_work() {
        let fixture = Fixture::new().await;
        let preparation = fixture.preparer();
        for nonce in 0..1000 {
            let mut message = fixture.message.clone();
            message.nonce = nonce;
            preparation.discover(message);
        }
        assert_eq!(preparation.messages.lock().len(), MAX_CONCURRENT);
        preparation.invalidate(fixture.message.origin);
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(preparation.permits.available_permits(), MAX_CONCURRENT);
    }

    #[tokio::test]
    async fn one_websocket_carries_advisory_and_confirmed_dispatches_without_advancing_early_cursors(
    ) {
        use crate::scraper_websocket::{ScraperSource, ScraperWebSocketMonitor};
        use futures_util::{SinkExt, StreamExt};
        use serde_json::{json, Value};
        use tokio::net::TcpListener;
        use tokio_tungstenite::{accept_async, tungstenite::Message};
        let fixture = Fixture::new().await;
        let preparation = Arc::new(fixture.preparer());
        let origin = fixture.message.origin;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let source = ScraperSource::new(
            "test1".into(),
            origin,
            H256::from_low_u64_be(1),
            H256::from_low_u64_be(3),
            H256::from_low_u64_be(2),
            fixture.db.clone(),
            None,
        )
        .unwrap();
        let metrics = hyperlane_base::CoreMetrics::new(
            "early-websocket-test",
            9090,
            prometheus::Registry::new(),
        )
        .unwrap();
        let monitor =
            ScraperWebSocketMonitor::new_with_authority(url, vec![source], &metrics, true)
                .unwrap()
                .with_preparation(preparation.clone(), &[origin].into_iter().collect());
        let task = tokio::spawn(monitor.run());
        let (tcp, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        socket
            .send(Message::Text(json!({"type":"ready"}).to_string().into()))
            .await
            .unwrap();
        let frame = socket.next().await.unwrap().unwrap();
        let request: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
        assert_eq!(request["streams"][0]["includeUnconfirmed"], true);
        let mut response = request["streams"].clone();
        for stream in response.as_array_mut().unwrap() {
            if let Some(cursors) = stream["cursors"].as_array_mut() {
                for cursor in cursors {
                    cursor.as_object_mut().unwrap().remove("allowReplay");
                }
            }
        }
        socket
            .send(Message::Text(
                json!({"type":"subscribed", "streams":response})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let data = json!({"origin_mailbox":format!("{:#x}", H256::from_low_u64_be(1)), "nonce":0,
            "sender":format!("{:#x}", fixture.message.sender), "recipient":format!("{:#x}", fixture.message.recipient),
            "destination_domain":fixture.message.destination, "msg_body":"0x01", "msg_id":format!("{:#x}", fixture.message.id()),
            "origin_block_height":"100", "origin_block_hash":format!("{:#x}", H256::from_low_u64_be(8)),
            "origin_tx_hash":format!("{:#x}", H256::from_low_u64_be(9))});
        let mut event = json!({"type":"event", "stage":"observed", "domain":origin, "eventType":"dispatch", "sequence":"0", "data":data});
        // A bad advisory payload must not disconnect the confirmed stream.
        let mut bad = event.clone();
        bad["data"]["msg_id"] = json!(format!("{:#x}", H256::zero()));
        socket
            .send(Message::Text(bad.to_string().into()))
            .await
            .unwrap();
        socket
            .send(Message::Text(event.to_string().into()))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if preparation
                    .messages
                    .lock()
                    .get(&fixture.message.id())
                    .is_some_and(|entry| entry.task.is_finished())
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(fixture
            .db
            .retrieve_message_by_id(&fixture.message.id())
            .unwrap()
            .is_none());
        assert!(fixture
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&0)
            .unwrap()
            .is_none());
        assert!(fixture.base.requests.activities.lock().unwrap().is_empty());
        socket.send(Message::Text(json!({"type":"block", "domain":origin, "height":"999", "headHeight":"999", "hash":format!("{:#x}", H256::zero())}).to_string().into())).await.unwrap();
        socket.send(Message::Text(json!({"type":"rollback", "stage":"observed", "domain":origin, "eventType":"dispatch", "toHeight":"99"}).to_string().into())).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !preparation.messages.lock().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(fixture
            .db
            .retrieve_message_by_id(&fixture.message.id())
            .unwrap()
            .is_none());
        socket
            .send(Message::Text(event.to_string().into()))
            .await
            .unwrap();
        event["stage"] = json!("confirmed");
        socket
            .send(Message::Text(event.to_string().into()))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture
                .db
                .retrieve_message_by_id(&fixture.message.id())
                .unwrap()
                .is_none()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(
            Duration::from_millis(250),
            preparation.notification(origin).unwrap().notified(),
        )
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "read-ahead must reuse the connection"
        );
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(preparation.messages.lock().is_empty());
    }
}
