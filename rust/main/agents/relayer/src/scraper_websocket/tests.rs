use super::*;
use async_trait::async_trait;
use futures_util::{FutureExt, SinkExt};
use hyperlane_base::{cursors::CursorType, db::DB};
use hyperlane_core::H512;
use hyperlane_core::{
    ChainResult, ContractSyncCursor, CursorAction, HyperlaneDomain, Indexed, Indexer, LogMeta,
    SequenceAwareIndexer,
};
use prometheus::Registry;
use std::{fmt::Debug, ops::RangeInclusive};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[derive(Debug, Clone)]
struct TestProvider(HyperlaneDomain);
impl hyperlane_core::HyperlaneChain for TestProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.0
    }
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}
#[async_trait]
impl HyperlaneProvider for TestProvider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<hyperlane_core::BlockInfo> {
        Ok(hyperlane_core::BlockInfo {
            number: height,
            hash: H256::from_low_u64_be(100),
            timestamp: 0,
        })
    }
    async fn get_txn_by_hash(&self, _: &H512) -> ChainResult<hyperlane_core::TxnInfo> {
        unreachable!()
    }
    async fn is_contract(&self, _: &H256) -> ChainResult<bool> {
        unreachable!()
    }
    async fn get_balance(&self, _: String) -> ChainResult<hyperlane_core::U256> {
        unreachable!()
    }
    async fn get_chain_metrics(&self) -> ChainResult<Option<hyperlane_core::ChainInfo>> {
        unreachable!()
    }
}
fn boundary(source: &ScraperSource, height: u64) -> LiveStartBoundary {
    LiveStartBoundary {
        domain: source.domain,
        height: height.to_string(),
        hash: format!("{:#x}", H256::from_low_u64_be(100)),
        confirmations: None,
        streams: Kind::ALL
            .into_iter()
            .filter(|k| *k != Kind::Gas || source.gas_indexing)
            .map(|kind| hyperlane_base::scraper_websocket::LiveStartStream {
                event_type: kind.label().into(),
                address: format!(
                    "{:#x}",
                    match kind {
                        Kind::Dispatch => source.mailbox,
                        Kind::Merkle => source.merkle_tree_hook,
                        Kind::Gas => source.interchain_gas_paymaster,
                    }
                ),
            })
            .collect(),
    }
}
fn accept_verified(state: &mut SourceState<'_>, height: u64) {
    state
        .accept_boundary(boundary(state.source, height))
        .unwrap();
    state
        .observe_probe(
            state.source.control.generation(),
            Ok(Some(RpcProbe::BoundaryVerified)),
        )
        .unwrap();
}
#[derive(Debug, Default)]
struct CountIndexer;
#[async_trait]
impl<T: Send + Sync + Debug + 'static> Indexer<T> for CountIndexer {
    async fn fetch_logs_in_range(
        &self,
        _: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        unreachable!()
    }
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        panic!("Sealevel does not support a block-height watermark")
    }
}
#[async_trait]
impl<T: Send + Sync + Debug + 'static> SequenceAwareIndexer<T> for CountIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        Ok((Some(2), 100))
    }
}
fn fixture() -> (tempfile::TempDir, ScraperSource, CoreMetrics) {
    let dir = tempfile::tempdir().unwrap();
    let db = HyperlaneRocksDB::new(
        &HyperlaneDomain::new_test_domain("base-test"),
        DB::from_path(dir.path()).unwrap(),
    );
    let metrics = CoreMetrics::new("live-cutover-test", 0, Registry::new()).unwrap();
    let source = ScraperSource {
        chain: "base".into(),
        domain: 8453,
        mailbox: H256::from_low_u64_be(1),
        merkle_tree_hook: H256::from_low_u64_be(2),
        interchain_gas_paymaster: H256::from_low_u64_be(3),
        database: db,
        broadcaster: None,
        provider: Arc::new(TestProvider(HyperlaneDomain::new_test_domain("base-test"))),
        freshness_indexer: Arc::new(CountIndexer),
        merkle_freshness_indexer: Arc::new(CountIndexer),
        sync_metrics: Arc::new(ContractSyncMetrics::new(&metrics)),
        gas_indexing: true,
        control: Arc::new(Authority::new(8453)),
    };
    (dir, source, metrics)
}
fn dispatch(nonce: u32) -> LiveEvent {
    LiveEvent::Dispatch(
        HyperlaneMessage {
            version: 3,
            nonce,
            origin: 8453,
            sender: H256::zero(),
            destination: 42161,
            recipient: H256::zero(),
            body: vec![1, 2],
        },
        100,
        H512::from_low_u64_be(u64::from(nonce) + 1),
    )
}
fn merkle(index: u32) -> LiveEvent {
    let LiveEvent::Dispatch(message, ..) = dispatch(index) else {
        unreachable!()
    };
    LiveEvent::Merkle(MerkleTreeInsertion::new(index, message.id()), 100)
}
#[derive(Debug)]
struct CompleteCursor(bool, u32, u32);
#[async_trait]
impl ContractSyncCursor<HyperlaneMessage> for CompleteCursor {
    async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
        Ok((CursorAction::Sleep(Duration::ZERO), Duration::ZERO))
    }
    fn latest_queried_block(&self) -> u32 {
        self.1
    }
    fn next_sequence(&self) -> Option<u32> {
        Some(self.2)
    }
    fn is_caught_up(&self) -> bool {
        self.0
    }
    async fn update(
        &mut self,
        _: Vec<(Indexed<HyperlaneMessage>, LogMeta)>,
        range: RangeInclusive<u32>,
    ) -> Result<()> {
        self.1 = *range.end();
        Ok(())
    }
}
async fn progress(source: &ScraperSource, kinds: &[Kind], complete: bool) {
    progress_at(source, kinds, complete, 100).await;
}
async fn progress_at(source: &ScraperSource, kinds: &[Kind], complete: bool, block: u32) {
    let receiver = source.control.receiver();
    for kind in kinds {
        RpcRecovery::track(
            Box::new(CompleteCursor(
                complete,
                block,
                source
                    .database
                    .retrieve_highest_message_nonce()
                    .unwrap()
                    .map(|n| n + 1)
                    .unwrap_or(0),
            )),
            Some(receiver.recovery(*kind)),
            CursorType::SequenceAware,
        )
        .next_action()
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn completed_block_gas_progress_does_not_wait_for_a_moving_tip() {
    for cursor_type in [CursorType::RateLimited, CursorType::SequenceAware] {
        let (_dir, source, _) = fixture();
        let mut state = SourceState::new(&source);
        accept_verified(&mut state, 100);
        progress(&source, &[Kind::Dispatch, Kind::Merkle], true).await;
        let block_gas = matches!(cursor_type, CursorType::RateLimited);
        let mut cursor = RpcRecovery::track(
            Box::new(CompleteCursor(false, 100, 0)),
            Some(source.control.receiver().recovery(Kind::Gas)),
            cursor_type,
        );
        cursor.next_action().await.unwrap();
        assert!(
            state.handoff_sequences().is_none(),
            "a planned range is not completed history"
        );
        cursor.update(vec![], 90..=99).await.unwrap();
        assert!(
            state.handoff_sequences().is_none(),
            "completed range must reach the boundary"
        );
        cursor.update(vec![], 100..=100).await.unwrap();
        assert_eq!(
            state.handoff_sequences().is_some(),
            block_gas,
            "sequence gas cursors still require backward history completion"
        );
    }
}

#[test]
fn fallback_isolates_one_origin_and_invalidates_its_pending_cutover() {
    let (_dir, source, metrics) = fixture();
    let mut other = source.clone();
    other.domain = 1;
    other.chain = "other".into();
    other.control = Arc::new(Authority::new(1));
    let monitor = ScraperWebSocketMonitor::new(
        Url::parse("ws://localhost").unwrap(),
        vec![source.clone(), other.clone()],
        &metrics,
    )
    .unwrap();
    let mut states = HashMap::from([
        (source.domain, SourceState::new(&source)),
        (other.domain, SourceState::new(&other)),
    ]);
    let failed_generation = source.control.request(source.control.generation()).unwrap();
    let healthy_generation = other.control.request(other.control.generation()).unwrap();
    for origin in [&source, &other] {
        monitor.active.with_label_values(&[&origin.chain]).set(1);
        monitor.authority.with_label_values(&[&origin.chain]).set(1);
    }
    monitor.fallback(&mut states, source.domain, "local failure");
    assert_eq!(monitor.active.with_label_values(&[&source.chain]).get(), 0);
    assert_eq!(monitor.active.with_label_values(&[&other.chain]).get(), 1);
    assert!(!states.contains_key(&source.domain));
    assert!(!source.control.current(failed_generation));
    assert!(states.contains_key(&other.domain));
    assert!(other.control.current(healthy_generation));
    assert_eq!(
        monitor.authority.with_label_values(&[&source.chain]).get(),
        0
    );
    assert_eq!(
        monitor.authority.with_label_values(&[&other.chain]).get(),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn probe_errors_share_grace_and_ignore_previous_generations() {
    let (_dir, source, _) = fixture();
    let mut recovering = SourceState::new(&source);
    let generation = source.control.generation();
    assert!(recovering
        .observe_probe(generation, Err(eyre::eyre!("unavailable")))
        .is_ok());
    tokio::time::advance(Duration::from_secs(301)).await;
    assert!(recovering
        .observe_probe(generation, Err(eyre::eyre!("unavailable")))
        .is_err());
    recovering
        .observe_probe(generation, Ok(Some(RpcProbe::BoundaryVerified)))
        .unwrap();
    assert!(
        recovering.health[0].observe_probe_failure(),
        "verification clears old failure grace"
    );
    let mut state = SourceState::new(&source);
    state.authoritative = true;
    state.next = [Some(2), Some(2)];
    let generation = source.control.request(source.control.generation()).unwrap();
    let failed = || Err(eyre::eyre!("RPC unavailable"));
    assert!(state.observe_probe(generation, failed()).is_ok());
    tokio::time::advance(Duration::from_secs(301)).await;
    assert!(state.observe_probe(generation, failed()).is_err());

    // A successful up-to-date probe resets the grace period.
    state
        .observe_probe(
            generation,
            Ok(Some(RpcProbe::Health(HealthProbe {
                height: 100,
                counts: [2, 2],
                observed: [2, 2],
            }))),
        )
        .unwrap();
    assert!(state.observe_probe(generation, failed()).is_ok());
    tokio::time::advance(Duration::from_secs(301)).await;
    source.control.resume();
    let current = source.control.request(source.control.generation()).unwrap();
    assert!(state.observe_probe(generation, failed()).is_ok());
    assert!(state.observe_probe(current, failed()).is_err());
}

#[tokio::test]
async fn gas_restart_height_advances_only_on_current_fresh_live_probes() {
    use hyperlane_core::{HyperlaneWatermarkedLogStore, InterchainGasPayment};
    let (_dir, source, _) = fixture();
    let mut state = SourceState::new(&source);
    state.next = [Some(2), Some(2)];
    let generation = source.control.request(source.control.generation()).unwrap();
    let probe = |height, counts| {
        Ok(Some(RpcProbe::Health(HealthProbe {
            height,
            counts,
            observed: [2, 2],
        })))
    };
    state.observe_probe(generation, probe(100, [2, 2])).unwrap();
    assert_eq!(
        HyperlaneWatermarkedLogStore::<InterchainGasPayment>::retrieve_high_watermark(
            &source.database
        )
        .await
        .unwrap(),
        None
    );
    state.authoritative = true;
    state.observe_probe(generation, probe(100, [3, 2])).unwrap();
    assert_eq!(
        HyperlaneWatermarkedLogStore::<InterchainGasPayment>::retrieve_high_watermark(
            &source.database
        )
        .await
        .unwrap(),
        None
    );
    state.observe_probe(generation, probe(200, [2, 2])).unwrap();
    state.observe_probe(generation, probe(190, [2, 2])).unwrap();
    source.control.resume();
    state.observe_probe(generation, probe(300, [2, 2])).unwrap();
    assert_eq!(
        HyperlaneWatermarkedLogStore::<InterchainGasPayment>::retrieve_high_watermark(
            &source.database
        )
        .await
        .unwrap(),
        Some(199)
    );
}

#[tokio::test]
async fn rejected_live_subscription_uses_slow_reconnect() {
    use hyperlane_base::scraper_websocket::{
        stream_retry_delay, REJECTED_STREAM_RETRY_DELAY, RETRY_DELAY,
    };
    let (_dir, source, metrics) = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("ws://{}", listener.local_addr().unwrap())).unwrap();
    let monitor = ScraperWebSocketMonitor::new(url, vec![source.clone()], &metrics).unwrap();
    let server = async {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(stream).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"ready"}"#.into()))
            .await
            .unwrap();
        socket.next().await.unwrap().unwrap();
        socket
            .send(Message::Text(
                r#"{"type":"error","error":"Subscription rejected"}"#.into(),
            ))
            .await
            .unwrap();
    };
    let (result, ()) = timeout(Duration::from_secs(5), async {
        tokio::join!(monitor.stream(StreamTimeouts::default()), server)
    })
    .await
    .unwrap();
    assert!(result
        .as_ref()
        .unwrap_err()
        .downcast_ref::<RejectedStream>()
        .is_some());
    assert_eq!(
        stream_retry_delay(&result, RETRY_DELAY),
        REJECTED_STREAM_RETRY_DELAY + RETRY_DELAY
    );
    assert!(!source.control.desired());
}

#[tokio::test]
async fn quiet_boundary_requires_verified_hash_and_all_rpc_history_including_gas() {
    let (_dir, source, _) = fixture();
    let mut state = SourceState::new(&source);
    state.accept_boundary(boundary(&source, 100)).unwrap();
    progress(&source, &Kind::ALL, true).await;
    assert!(
        state.handoff_sequences().is_none(),
        "boundary must be independently verified"
    );
    source
        .verify_boundary(state.boundary.unwrap())
        .await
        .unwrap();
    // Only complete, fresh cursor reports at/above B may authorize handoff.
    let mut state = SourceState::new(&source);
    accept_verified(&mut state, 100);
    progress(&source, &Kind::ALL, false).await;
    assert!(state.handoff_sequences().is_none());
    progress_at(&source, &Kind::ALL, true, 99).await;
    assert!(state.handoff_sequences().is_none());
    progress(&source, &[Kind::Dispatch, Kind::Merkle], true).await;
    assert!(
        state.handoff_sequences().is_none(),
        "gas history is required even without a gas event"
    );
    progress(&source, &[Kind::Gas], true).await;
    assert!(state.handoff_sequences().is_some());
    assert!(
        state.pending.is_empty(),
        "quiet chains need no anchor events"
    );
    state.finish_handoff().unwrap();
    assert!(state.authoritative);
    assert_eq!(state.next, [Some(0), Some(0)]);
    // A missing first live event must still be detected on a quiet chain.
    assert!(state.ingest(dispatch(1)).is_err());
}

#[tokio::test]
async fn boundary_rejects_wrong_hash_contracts_policy_and_incomplete_streams() {
    let (_dir, source, _) = fixture();
    let mut wrong = boundary(&source, 100);
    wrong.streams[0].address = format!("{:#x}", H256::zero());
    assert!(SourceState::new(&source).accept_boundary(wrong).is_err());
    let mut wrong = boundary(&source, 100);
    wrong.confirmations = Some(0);
    assert!(SourceState::new(&source).accept_boundary(wrong).is_err());
    let mut wrong = boundary(&source, 100);
    wrong.streams.pop();
    assert!(SourceState::new(&source).accept_boundary(wrong).is_err());
    assert!(source
        .verify_boundary(Boundary {
            height: 100,
            hash: H256::zero()
        })
        .await
        .is_err());
    let mut future = SourceState::new(&source);
    accept_verified(&mut future, 101);
    progress(&source, &Kind::ALL, true).await;
    assert!(
        future.handoff_sequences().is_none(),
        "RPC confirmation frontier must cover the boundary"
    );
}

#[tokio::test]
async fn boundary_cutover_preserves_configured_floor_sequence_without_local_events() {
    let (_dir, source, _) = fixture();
    let mut state = SourceState::new(&source);
    accept_verified(&mut state, 100);
    for kind in Kind::ALL {
        RpcRecovery::track(
            Box::new(CompleteCursor(true, 100, 700)),
            Some(source.control.receiver().recovery(kind)),
            CursorType::SequenceAware,
        )
        .next_action()
        .await
        .unwrap();
    }
    assert!(state.handoff_sequences().is_some());
    state.finish_handoff().unwrap();
    assert_eq!(state.next, [Some(700), Some(700)]);
    state.ingest(dispatch(700)).unwrap();
    state.ingest(merkle(700)).unwrap();
    assert!(dispatch(700).matches(&source.database).unwrap());
    assert!(state.ingest(merkle(702)).is_err());
}

#[tokio::test]
async fn old_rpc_progress_and_stale_pause_ack_cannot_authorize_reconnect() {
    let (_dir, source, _) = fixture();
    progress(&source, &Kind::ALL, true).await;
    let mut state = SourceState::new(&source);
    accept_verified(&mut state, 100);
    for event in [dispatch(1), merkle(1)] {
        source.store(&event).unwrap();
        state.ingest(event).unwrap();
    }
    assert!(state.handoff_sequences().is_none());
    let scheduled = source.control.generation();
    source.control.resume();
    assert!(
        source.control.request(scheduled).is_none(),
        "cancelled cutover cannot pause RPC"
    );
    let old = source.control.request(source.control.generation()).unwrap();
    source.control.receiver().mark_paused(source.domain, old);
    source.control.resume();
    let next = source.control.request(source.control.generation()).unwrap();
    assert!(!source.control.current(old));
    assert!(source.control.paused(next).now_or_never().is_none());
    source.control.resume();
    assert!(!source.control.paused(next).await);
}

#[test]
fn gaps_conflicts_and_full_buffers_require_rpc_recovery() {
    let (_dir, source, _) = fixture();
    let mut state = SourceState::new(&source);
    state.ingest(dispatch(0)).unwrap();
    assert!(state.ingest(dispatch(2)).is_err());
    let mut conflict = dispatch(0);
    if let LiveEvent::Dispatch(message, ..) = &mut conflict {
        message.body.push(3);
    }
    assert!(state.ingest(conflict).is_err());
    let mut state = SourceState::new(&source);
    for n in 0..MAX_HANDOFF_EVENTS as u32 {
        state.ingest(dispatch(n)).unwrap();
    }
    assert!(state.ingest(dispatch(MAX_HANDOFF_EVENTS as u32)).is_err());
    assert!(source
        .database
        .retrieve_message_by_nonce(0)
        .unwrap()
        .is_none());
    let mut oversized = SourceState::new(&source);
    let LiveEvent::Dispatch(mut message, block, tx) = dispatch(0) else {
        unreachable!()
    };
    message.body = vec![0; MAX_HANDOFF_BYTES + 1];
    assert!(oversized
        .ingest(LiveEvent::Dispatch(message, block, tx))
        .is_err());
}

#[test]
fn wrong_domain_and_missing_dispatch_body_are_rejected() {
    let (_dir, source, _) = fixture();
    let mut wire = wire_event(&dispatch(0), &source);
    wire["domain"] = serde_json::json!(1);
    assert!(LiveEvent::decode(serde_json::from_value(wire.clone()).unwrap(), &source).is_err());
    wire["domain"] = serde_json::json!(source.domain);
    wire["data"]["msg_body"] = serde_json::Value::Null;
    assert!(LiveEvent::decode(serde_json::from_value(wire).unwrap(), &source).is_err());
}

fn wire_event(event: &LiveEvent, source: &ScraperSource) -> serde_json::Value {
    let (kind, sequence) = event.sequence().unwrap();
    let data = match event {
        LiveEvent::Dispatch(m, block, tx) => {
            serde_json::json!({ "origin_mailbox": format!("{:#x}", source.mailbox), "origin_domain": source.domain, "nonce": m.nonce, "sender": format!("{:#x}", m.sender), "recipient": format!("{:#x}", m.recipient), "destination_domain": m.destination, "msg_body": hex::encode(&m.body), "msg_id": format!("{:#x}", m.id()), "origin_block_height": block, "origin_tx_hash": format!("{tx:#x}") })
        }
        LiveEvent::Merkle(m, block) => {
            serde_json::json!({ "domain": source.domain, "merkle_tree_hook": format!("{:#x}", source.merkle_tree_hook), "leaf_index": m.index(), "message_id": format!("{:#x}", m.message_id()), "block_number": block })
        }
        _ => unreachable!(),
    };
    serde_json::json!({"type": "event", "domain": source.domain, "eventType": kind.label(), "sequence": sequence.to_string(), "data": data})
}

async fn subscribed_socket(
    listener: &TcpListener,
) -> (
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    serde_json::Value,
) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut socket = accept_async(stream).await.unwrap();
    socket
        .send(Message::Text(
            serde_json::json!({"type":"ready"}).to_string().into(),
        ))
        .await
        .unwrap();
    let request = socket.next().await.unwrap().unwrap();
    let request: serde_json::Value = serde_json::from_str(request.to_text().unwrap()).unwrap();
    socket
        .send(Message::Text(
            serde_json::json!({"type":"subscribed", "streams":request["streams"]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    (socket, request)
}

fn wire_boundary(source: &ScraperSource) -> Message {
    let marker = boundary(source, 100);
    Message::Text(serde_json::json!({"type":"live_start", "domain":marker.domain,"height":marker.height,"hash":marker.hash,
        "streams":marker.streams.iter().map(|s| serde_json::json!({"eventType":s.event_type,"address":s.address})).collect::<Vec<_>>()}).to_string().into())
}

#[tokio::test]
async fn unavailable_boundary_is_retried_with_a_fresh_subscription() {
    let (_dir, source, metrics) = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("ws://{}", listener.local_addr().unwrap())).unwrap();
    let monitor = ScraperWebSocketMonitor::new(url, vec![source.clone()], &metrics).unwrap();
    let retry_grace = Duration::from_millis(100);
    for unavailable in [true, false] {
        let session = monitor.stream(StreamTimeouts {
            progress_check: Duration::from_millis(5),
            progress_grace: retry_grace,
            ..Default::default()
        });
        let server = async {
            let (mut socket, _) = subscribed_socket(&listener).await;
            if unavailable {
                let sent_at = Instant::now();
                socket
                    .send(Message::Text(
                        serde_json::json!({"type":"live_start_unavailable","domain":source.domain})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                // Fallback advances the generation even while RPC is running.
                while source.control.generation() == 0 {
                    tokio::task::yield_now().await;
                }
                assert!(!source.control.desired());
                assert_eq!(
                    monitor.active.with_label_values(&[&source.chain]).get(),
                    0,
                    "unavailable origin is using RPC indexing"
                );
                let _ = socket.next().await;
                assert!(
                    sent_at.elapsed() >= retry_grace,
                    "no immediate reconnect loop"
                );
                return;
            }
            socket.send(wire_boundary(&source)).await.unwrap();
            progress(&source, &Kind::ALL, true).await;
            let mut receiver = source.control.receiver();
            loop {
                let command = receiver.borrow_and_update();
                if command.desired {
                    receiver.mark_paused(source.domain, command.generation);
                    break;
                }
                receiver.changed().await.unwrap();
            }
            while monitor.authority.with_label_values(&[&source.chain]).get() != 1 {
                tokio::task::yield_now().await;
            }
            socket.close(None).await.unwrap();
        };
        let (result, ()) = timeout(Duration::from_secs(3), async {
            tokio::join!(session, server)
        })
        .await
        .unwrap();
        if unavailable {
            assert!(result.is_ok());
        }
        assert!(!source.control.desired());
    }
}

#[tokio::test]
async fn socket_cutover_waits_for_pause_and_recovers_after_disconnect_without_replay() {
    let (_dir, source, metrics) = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("ws://{}", listener.local_addr().unwrap())).unwrap();
    let mut other = source.clone();
    other.domain = 1;
    other.chain = "other".into();
    other.gas_indexing = false;
    other.control = Arc::new(Authority::new(other.domain));
    let monitor = ScraperWebSocketMonitor::new(url, vec![source.clone(), other], &metrics).unwrap();
    for first in [20, 30] {
        let session = monitor.stream(StreamTimeouts {
            progress_check: Duration::from_millis(5),
            ..Default::default()
        });
        let server = async {
            let (mut socket, request) = subscribed_socket(&listener).await;
            let streams = request["streams"].as_array().unwrap();
            assert_eq!(streams.len(), 3);
            for stream in streams {
                assert!(stream.get("cursors").is_none());
                assert!(stream.get("streamCursorVersion").is_none());
                assert!(stream.get("confirmations").is_none());
                let domains = if stream["eventType"] == "gas_payment" {
                    serde_json::json!([8453])
                } else {
                    serde_json::json!([1, 8453])
                };
                assert_eq!(stream["domains"], domains);
            }
            if first == 20 {
                socket
                    .send(Message::Text(
                        serde_json::json!({"type":"live_start_unavailable","domain":1})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            } else {
                let mut invalid = wire_boundary(&source);
                if let Message::Text(text) = &mut invalid {
                    let mut marker: serde_json::Value = serde_json::from_str(text).unwrap();
                    marker["domain"] = 1.into();
                    marker["streams"][0]["address"] = format!("{:#x}", H256::zero()).into();
                    *text = marker.to_string().into();
                }
                socket.send(invalid).await.unwrap();
            }
            // Unavailable boundaries and contract mismatches stay isolated even
            // if the failed origin continues sending events.
            socket
                .send(Message::Text(
                    serde_json::json!({"type":"event","domain":1,"eventType":"dispatch","data":{}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            socket.send(wire_boundary(&source)).await.unwrap();
            for event in [
                dispatch(first),
                merkle(first),
                dispatch(first + 1),
                merkle(first + 1),
            ] {
                socket
                    .send(Message::Text(
                        wire_event(&event, &source).to_string().into(),
                    ))
                    .await
                    .unwrap();
            }
            source.store(&dispatch(first)).unwrap();
            source.store(&merkle(first)).unwrap();
            progress(&source, &Kind::ALL, true).await;
            let mut receiver = source.control.receiver();
            timeout(Duration::from_secs(2), async {
                loop {
                    let command = receiver.borrow_and_update();
                    if command.desired {
                        break command;
                    }
                    receiver.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
            assert!(
                source
                    .database
                    .retrieve_message_by_nonce(first + 1)
                    .unwrap()
                    .is_none(),
                "socket writes must wait for RPC cancellation acknowledgement"
            );
            let command = receiver.borrow_and_update();
            receiver.mark_paused(source.domain, command.generation);
            timeout(Duration::from_secs(2), async {
                while monitor.authority.with_label_values(&[&source.chain]).get() != 1 {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            assert!(dispatch(first + 1).matches(&source.database).unwrap());
            assert!(merkle(first + 1).matches(&source.database).unwrap());
            // Once cutover finishes, new events are written directly.
            let live = dispatch(first + 2);
            socket
                .send(Message::Text(wire_event(&live, &source).to_string().into()))
                .await
                .unwrap();
            timeout(Duration::from_secs(2), async {
                while !live.matches(&source.database).unwrap() {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            let coverage = hyperlane_core::HyperlaneBackwardCursorStore::<HyperlaneMessage>::retrieve_sequence_coverage(&source.database).await.unwrap().unwrap();
            // The second fixture session skips 23..29 without storing them.
            // Live writes extend 20..22, but must not bridge that artificial gap.
            assert_eq!(coverage.last, 22, "coverage must remain contiguous");
            socket.close(None).await.unwrap();
        };
        let (result, ()) = timeout(Duration::from_secs(5), async {
            tokio::join!(session, server)
        })
        .await
        .unwrap();
        let _ = result; // EOF and a WebSocket close both restore RPC through the same guard.
        assert!(!source.control.desired());
        assert_eq!(
            monitor.authority.with_label_values(&[&source.chain]).get(),
            0
        );
    }
}

#[tokio::test]
async fn rpc_and_live_gas_overlap_is_not_double_credited() {
    use hyperlane_core::{GasPaymentKey, InterchainGasPayment, U256};
    let (_dir, source, _) = fixture();
    let key = GasPaymentKey {
        message_id: H256::from_low_u64_be(7),
        destination: 42161,
    };
    let payment = Indexed::new(InterchainGasPayment {
        message_id: key.message_id,
        destination: key.destination,
        payment: U256::from(100),
        gas_amount: U256::from(50),
    });
    let meta = LogMeta {
        address: source.interchain_gas_paymaster,
        block_number: 100,
        block_hash: H256::from_low_u64_be(1),
        transaction_id: H512::from_low_u64_be(2),
        transaction_index: 0,
        log_index: U256::zero(),
    };
    source
        .database
        .process_indexed_gas_payment(payment, &meta)
        .unwrap();
    source.store(&LiveEvent::Gas(payment, meta)).unwrap();
    assert_eq!(hyperlane_core::HyperlaneWatermarkedLogStore::<InterchainGasPayment>::retrieve_high_watermark(&source.database).await.unwrap(), Some(99));
    assert_eq!(
        source
            .database
            .retrieve_gas_payment_by_gas_payment_key(key)
            .unwrap()
            .unwrap()
            .payment,
        U256::from(100)
    );
}

/// Run against an actual proxy + PostgreSQL fixture with domain 8453, checkpoint
/// 100/hash H256::from_low_u64_be(100), and contract addresses 1/2/3.
#[tokio::test]
#[ignore = "requires RELAYER_TEST_PROXY_URL and an isolated scraper PostgreSQL fixture"]
async fn real_proxy_quiet_boundary_cutover() {
    let (_dir, source, metrics) = fixture();
    let url = Url::parse(&std::env::var("RELAYER_TEST_PROXY_URL").expect("proxy URL")).unwrap();
    let monitor = ScraperWebSocketMonitor::new(url, vec![source.clone()], &metrics).unwrap();
    let check = async {
        timeout(Duration::from_secs(10), async {
            while monitor.active.with_label_values(&[&source.chain]).get() != 1 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("actual proxy subscription");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !source.control.desired(),
            "boundary alone must not stop RPC"
        );
        assert_eq!(
            monitor.authority.with_label_values(&[&source.chain]).get(),
            0
        );
        progress(&source, &[Kind::Dispatch, Kind::Merkle], true).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!source.control.desired(), "gas history still missing");
        progress(&source, &[Kind::Gas], true).await;
        let mut receiver = source.control.receiver();
        timeout(Duration::from_secs(10), async {
            loop {
                let command = receiver.borrow_and_update();
                if command.desired {
                    receiver.mark_paused(source.domain, command.generation);
                    break;
                }
                receiver.changed().await.unwrap();
            }
            while monitor.authority.with_label_values(&[&source.chain]).get() != 1 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("quiet chain must switch without a dispatch");
        assert!(source
            .database
            .retrieve_highest_message_nonce()
            .unwrap()
            .is_none());
    };
    tokio::select! {
        result=monitor.stream(StreamTimeouts {progress_check:Duration::from_millis(10),..Default::default()}) => panic!("unexpected disconnect: {result:?}"),
        ()=check => {}
    }
    assert!(
        !source.control.desired(),
        "dropping the connection restores RPC"
    );
}
