//! Connection-scoped scheduling of scraper events and canonical progress probes.

use std::{collections::HashSet, time::Duration};

use eyre::{bail, Result};
use futures_util::{
    future::BoxFuture,
    stream::{BoxStream, FuturesUnordered},
    FutureExt, StreamExt,
};
use serde::de::DeserializeOwned;
use tokio::time::{interval, Instant, Interval, MissedTickBehavior};

use super::{
    validate_subscription, ScraperWebSocket, ServerMessage, StreamTimeouts, SubscribeMessage,
    SubscribedStream,
};

/// Work produced by a scraper session. Probe results carry agent-specific data.
#[derive(Debug)]
pub enum SessionEvent<T, P, C = ()> {
    /// A validated protocol envelope from the scraper.
    Message(ServerMessage<T>),
    /// One completed canonical progress probe.
    Progress(P),
    /// One source completed its agent-specific cutover work.
    Cutover {
        /// Source whose cutover finished.
        domain: u32,
        /// Agent-specific completion result.
        result: C,
    },
}

/// Owns both the connection and its in-flight canonical probes.
/// Dropping a session cancels its probes; no result can cross a reconnect.
/// Probes remain in flight across incoming messages and emit individually.
pub struct ScraperSession<P, C = ()> {
    socket: ScraperWebSocket,
    ticker: Interval,
    probes: Option<BoxStream<'static, P>>,
    expected_subscription: Option<Vec<SubscribedStream>>,
    cutovers: FuturesUnordered<BoxFuture<'static, (u32, C)>>,
    pending_cutovers: HashSet<u32>,
}

impl<P: Send + 'static, C: Send + 'static> ScraperSession<P, C> {
    /// Connect and schedule the first canonical probe after the progress interval.
    pub async fn connect(url: &url::Url, timeouts: StreamTimeouts) -> Result<Self> {
        let socket = ScraperWebSocket::connect(url, timeouts.read).await?;
        Ok(Self::new(socket, timeouts.progress_check))
    }

    fn new(socket: ScraperWebSocket, progress_check: Duration) -> Self {
        let mut ticker = interval(progress_check);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        ticker.reset();
        Self {
            socket,
            ticker,
            probes: None,
            expected_subscription: None,
            cutovers: FuturesUnordered::new(),
            pending_cutovers: HashSet::new(),
        }
    }

    /// Submit the agent's durable-cursor subscription.
    pub async fn subscribe(&mut self, subscription: SubscribeMessage<'_>) -> Result<()> {
        let expected = subscription.confirmation();
        self.socket
            .subscribe(serde_json::to_string(&subscription)?)
            .await?;
        self.expected_subscription = Some(expected);
        Ok(())
    }

    /// Run one cutover per source alongside socket reads and progress probes.
    /// Duplicate requests are ignored until completion. Dropping the connection
    /// cancels unfinished work; agents restore RPC before reconnecting.
    pub fn start_cutover(
        &mut self,
        domain: u32,
        work: impl std::future::Future<Output = C> + Send + 'static,
    ) {
        if self.pending_cutovers.insert(domain) {
            self.cutovers
                .push(async move { (domain, work.await) }.boxed());
        }
    }

    /// Receive messages while probing without overlap or cancelling slow probes.
    /// The factory starts a batch only when the preceding batch has completed.
    pub async fn next<T: DeserializeOwned>(
        &mut self,
        probes_enabled: bool,
        mut start_probes: impl FnMut() -> BoxStream<'static, P>,
    ) -> Result<Option<SessionEvent<T, P, C>>> {
        loop {
            // Check even when other work is immediately ready. Let recv own its
            // moving deadline: ping frames can extend it without returning a message.
            if Instant::now() >= self.socket.read_deadline() {
                bail!("Scraper WebSocket heartbeat timed out");
            }
            tokio::select! {
                Some((domain, result)) = self.cutovers.next(), if !self.cutovers.is_empty() => {
                    self.pending_cutovers.remove(&domain);
                    return Ok(Some(SessionEvent::Cutover { domain, result }));
                }
                probe = async { self.probes.as_mut().expect("guarded probe batch").next().await }, if self.probes.is_some() => {
                    match probe {
                        Some(probe) => return Ok(Some(SessionEvent::Progress(probe))),
                        None => self.probes = None,
                    }
                }
                _ = self.ticker.tick(), if probes_enabled && self.probes.is_none() => {
                    self.probes = Some(start_probes());
                }
                message = self.socket.recv() => {
                    let message = message?;
                    if let Some(ServerMessage::Subscribed { streams }) = &message {
                        let expected = self.expected_subscription.as_ref()
                            .ok_or_else(|| eyre::eyre!("Scraper acknowledged a subscription before it was sent"))?;
                        validate_subscription(expected, streams)?;
                    }
                    return Ok(message.map(SessionEvent::Message));
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scraper_websocket::client::tests::connection;
    use futures_util::{stream, SinkExt};
    use serde_json::Value;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use tokio::{
        sync::oneshot,
        time::{advance, timeout},
    };
    use tokio_tungstenite::tungstenite::Message;

    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn pending_cutover_does_not_block_messages_probes_or_other_sources() {
        let (client, mut server) = connection(Duration::from_secs(75)).await;
        tokio::time::pause();
        let mut session = ScraperSession::<u32>::new(client, Duration::from_secs(10));
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = DropFlag(dropped.clone());
        session.start_cutover(1, async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        });
        session.start_cutover(1, async { panic!("duplicate cutover must not run") });
        session.start_cutover(2, async {});
        server
            .send(Message::Text(r#"{"type":"heartbeat"}"#.into()))
            .await
            .expect("heartbeat");
        let mut received = [false; 3];
        while !received.iter().all(|received| *received) {
            match timeout(
                Duration::from_secs(15),
                session.next::<Value>(true, || stream::once(async { 7 }).boxed()),
            )
            .await
            .expect("work must not wait for source 1")
            .expect("session")
            .expect("event")
            {
                SessionEvent::Message(ServerMessage::Other) => received[0] = true,
                SessionEvent::Progress(7) => received[1] = true,
                SessionEvent::Cutover { domain: 2, .. } => received[2] = true,
                event => panic!("unexpected event: {event:?}"),
            }
        }
        assert!(!dropped.load(Ordering::SeqCst));
        // A completed source can schedule another cutover; a pending source cannot.
        session.start_cutover(2, async {});
        assert!(matches!(
            session
                .next::<Value>(false, || stream::empty().boxed())
                .await
                .expect("session"),
            Some(SessionEvent::Cutover { domain: 2, .. })
        ));
        drop(session);
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn subscription_confirmation_is_checked_before_delivery() {
        for matching in [true, false] {
            let (client, mut server) = connection(Duration::from_secs(75)).await;
            let mut session = ScraperSession::<u32>::new(client, Duration::from_secs(30));
            server
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .expect("ready");
            session
                .next::<Value>(false, || stream::empty().boxed())
                .await
                .expect("ready");
            session
                .subscribe(SubscribeMessage {
                    streams: vec![super::super::SubscribeStream {
                        cursors: None,
                        domains: Some(vec![1]),
                        event_type: "merkle_tree_insertion",
                        stream_cursor_version: None,
                    }],
                    message_type: "subscribe",
                })
                .await
                .expect("subscribe");
            server.next().await.expect("request").expect("read request");
            let domain = if matching { 1 } else { 2 };
            server.send(Message::Text(format!(r#"{{"type":"subscribed","streams":[{{"domains":[{domain}],"eventType":"merkle_tree_insertion"}}]}}"#).into())).await.expect("ack");
            let result = session
                .next::<Value>(false, || stream::empty().boxed())
                .await;
            if matching {
                assert!(matches!(
                    result.expect("matching ack"),
                    Some(SessionEvent::Message(ServerMessage::Subscribed { .. }))
                ));
            } else {
                assert!(result
                    .expect_err("wrong domain")
                    .to_string()
                    .contains("confirmation does not match"));
            }
        }
    }

    #[tokio::test]
    async fn fast_probe_is_delivered_before_slow_peer_and_session_drop_cancels_peer() {
        let (client, _server) = connection(Duration::from_secs(75)).await;
        tokio::time::pause();
        let dropped = Arc::new(AtomicBool::new(false));
        let mut session = ScraperSession::<u32>::new(client, Duration::from_secs(10));
        let event = session
            .next::<Value>(true, || {
                let guard = DropFlag(dropped.clone());
                stream::select(
                    stream::once(async move {
                        let _guard = guard;
                        std::future::pending::<u32>().await
                    }),
                    stream::once(async { 2 }),
                )
                .boxed()
            })
            .await
            .expect("session")
            .expect("probe");
        assert!(matches!(event, SessionEvent::Progress(2)));
        assert!(!dropped.load(Ordering::SeqCst));
        drop(session);
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn incoming_messages_do_not_cancel_or_restart_pending_probe() {
        let (client, mut server) = connection(Duration::from_secs(75)).await;
        tokio::time::pause();
        let mut session = ScraperSession::<u32>::new(client, Duration::from_secs(10));
        let calls = Arc::new(AtomicUsize::new(0));
        let (finish, receiver) = oneshot::channel();
        let mut receiver = Some(receiver);
        let mut factory = || {
            calls.fetch_add(1, Ordering::SeqCst);
            let receiver = receiver.take().expect("probe starts once");
            stream::once(async move { receiver.await.expect("finish probe") }).boxed()
        };
        assert!(timeout(
            Duration::from_secs(11),
            session.next::<Value>(true, &mut factory)
        )
        .await
        .is_err());
        for _ in 0..3 {
            advance(Duration::from_secs(10)).await;
            server
                .send(Message::Text(r#"{"type":"heartbeat"}"#.into()))
                .await
                .expect("heartbeat");
            assert!(matches!(
                session
                    .next::<Value>(true, &mut factory)
                    .await
                    .expect("session"),
                Some(SessionEvent::Message(ServerMessage::Other))
            ));
        }
        finish.send(42).expect("complete probe");
        assert!(matches!(
            session
                .next::<Value>(true, &mut factory)
                .await
                .expect("probe"),
            Some(SessionEvent::Progress(42))
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ready_probe_results_cannot_hide_heartbeat_timeout() {
        let (client, _server) = connection(Duration::from_secs(75)).await;
        tokio::time::pause();
        let mut session = ScraperSession::<u32>::new(client, Duration::from_secs(10));
        let mut factory = || stream::repeat(1u32).boxed();
        assert!(matches!(
            session
                .next::<Value>(true, &mut factory)
                .await
                .expect("first probe"),
            Some(SessionEvent::Progress(1))
        ));
        advance(Duration::from_secs(75)).await;
        let error = session
            .next::<Value>(true, &mut factory)
            .await
            .expect_err("heartbeat must win");
        assert!(error.to_string().contains("heartbeat timed out"));
    }
}
