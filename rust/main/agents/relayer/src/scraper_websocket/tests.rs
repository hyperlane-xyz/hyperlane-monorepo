use super::*;
use async_trait::async_trait;
use futures_util::{FutureExt, SinkExt};
use hyperlane_base::db::DB;
use hyperlane_core::H512;
use hyperlane_core::{
    ChainResult, ContractSyncCursor, CursorAction, HyperlaneDomain, Indexed, Indexer, LogMeta,
    SequenceAwareIndexer,
};
use prometheus::Registry;
use std::{fmt::Debug, ops::RangeInclusive};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[derive(Debug)]
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
        Ok(100)
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
        freshness_indexer: Arc::new(CountIndexer),
        merkle_freshness_indexer: Arc::new(CountIndexer),
        sync_metrics: Arc::new(ContractSyncMetrics::new(&metrics)),
        gas_enabled: true,
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
struct CompleteCursor(bool);
#[async_trait]
impl ContractSyncCursor<HyperlaneMessage> for CompleteCursor {
    async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
        Ok((CursorAction::Sleep(Duration::ZERO), Duration::ZERO))
    }
    fn latest_queried_block(&self) -> u32 {
        100
    }
    fn is_caught_up(&self) -> bool {
        self.0
    }
    async fn update(
        &mut self,
        _: Vec<(Indexed<HyperlaneMessage>, LogMeta)>,
        _: RangeInclusive<u32>,
    ) -> Result<()> {
        self.0 = true;
        Ok(())
    }
}
async fn progress(source: &ScraperSource, kinds: &[Kind], complete: bool) {
    let receiver = source.control.receiver();
    for kind in kinds {
        RpcRecovery::track(
            Box::new(CompleteCursor(complete)),
            Some(receiver.recovery(*kind)),
        )
        .next_action()
        .await
        .unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn probe_errors_share_grace_and_ignore_previous_generations() {
    let (_dir, source, _) = fixture();
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
            Ok(Some(HealthProbe {
                counts: [2, 2],
                observed: [2, 2],
            })),
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
async fn overlap_requires_complete_rpc_history_including_gas() {
    let (_dir, source, _) = fixture();
    let mut state = SourceState::new(&source);
    for event in [dispatch(7), merkle(7)] {
        state.ingest(event).unwrap();
    }
    assert!(!state.overlap_ready().unwrap());
    source.store(&dispatch(7)).unwrap();
    source.store(&merkle(7)).unwrap();
    // Merely finding the anchor does not prove earlier history was filled.
    progress(&source, &Kind::ALL, false).await;
    assert!(!state.overlap_ready().unwrap());
    progress(&source, &[Kind::Dispatch, Kind::Merkle], true).await;
    assert!(
        !state.overlap_ready().unwrap(),
        "gas recovery must also finish"
    );
    progress(&source, &[Kind::Gas], true).await;
    assert!(state.overlap_ready().unwrap());
}

#[tokio::test]
async fn completed_gas_query_records_recovery_before_the_next_poll() {
    let (_dir, source, _) = fixture();
    let mut state = SourceState::new(&source);
    for event in [dispatch(7), merkle(7)] {
        source.store(&event).unwrap();
        state.ingest(event).unwrap();
    }
    progress(&source, &[Kind::Dispatch, Kind::Merkle], true).await;
    let mut gas = RpcRecovery::track(
        Box::new(CompleteCursor(false)),
        Some(source.control.receiver().recovery(Kind::Gas)),
    );
    gas.next_action().await.unwrap();
    assert!(!state.overlap_ready().unwrap());
    gas.update(vec![], 90..=100).await.unwrap();
    assert!(state.overlap_ready().unwrap());
}

#[tokio::test]
async fn old_rpc_progress_and_stale_pause_ack_cannot_authorize_reconnect() {
    let (_dir, source, _) = fixture();
    progress(&source, &Kind::ALL, true).await;
    let mut state = SourceState::new(&source);
    for event in [dispatch(1), merkle(1)] {
        source.store(&event).unwrap();
        state.ingest(event).unwrap();
    }
    assert!(!state.overlap_ready().unwrap());
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
    let (_dir, source, metrics) = fixture();
    let monitor = ScraperWebSocketMonitor::new(
        Url::parse("ws://localhost:1").unwrap(),
        vec![source.clone()],
        &metrics,
    )
    .unwrap();
    let mut state = SourceState::new(&source);
    state.ingest(dispatch(0)).unwrap();
    assert!(state.ingest(dispatch(2)).is_err());
    let mut conflict = dispatch(0);
    if let LiveEvent::Dispatch(message, ..) = &mut conflict {
        message.body.push(3);
    }
    assert!(state.ingest(conflict).is_err());
    source.control.request(source.control.generation()).unwrap();
    monitor.fallback(&mut state, eyre::eyre!("gap"));
    assert!(!source.control.desired());
    assert!(state.pending.is_empty());
    for n in 0..MAX_HANDOFF_EVENTS as u32 {
        state.ingest(dispatch(n)).unwrap();
    }
    let overflow = state
        .ingest(dispatch(MAX_HANDOFF_EVENTS as u32))
        .unwrap_err();
    monitor.fallback(&mut state, overflow);
    assert!(state.pending.is_empty());
    assert!(!state.authoritative);
    state.ingest(dispatch(100)).unwrap(); // A fresh overlap can start after recovery.
    assert!(source
        .database
        .retrieve_message_by_nonce(0)
        .unwrap()
        .is_none());
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

#[tokio::test]
async fn socket_cutover_waits_for_pause_and_recovers_after_disconnect_without_replay() {
    let (_dir, source, metrics) = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("ws://{}", listener.local_addr().unwrap())).unwrap();
    let mut other = source.clone();
    other.domain = 1;
    other.chain = "other".into();
    other.gas_enabled = false;
    other.control = Arc::new(Authority::new(other.domain));
    let monitor = ScraperWebSocketMonitor::new(url, vec![source.clone(), other], &metrics).unwrap();
    for first in [20, 30] {
        let session = monitor.stream(StreamTimeouts {
            progress_check: Duration::from_millis(5),
            ..Default::default()
        });
        let server = async {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            socket
                .send(Message::Text(
                    serde_json::json!({"type":"ready"}).to_string().into(),
                ))
                .await
                .unwrap();
            let request = socket.next().await.unwrap().unwrap();
            let request: serde_json::Value =
                serde_json::from_str(request.to_text().unwrap()).unwrap();
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
            socket
                .send(Message::Text(
                    serde_json::json!({"type":"subscribed", "streams": request["streams"]})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
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

#[test]
fn rpc_and_live_gas_overlap_is_not_double_credited() {
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
