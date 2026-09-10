//! Shared scraper connection, handshake, and RPC fallback policy.

use std::{pin::Pin, time::Duration};

use eyre::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use tokio::{
    net::TcpStream,
    time::{sleep, timeout, Instant, Sleep},
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

use super::ServerMessage;

/// Delay between ordinary connection retries.
pub const RETRY_DELAY: Duration = Duration::from_secs(5);
// Rejected subscriptions usually require scraper history/configuration to change.
// Keep RPC indexing active and periodically probe instead of hammering catch-up.
/// Additional delay after a rejected subscription.
pub const REJECTED_STREAM_RETRY_DELAY: Duration = Duration::from_secs(300);
/// Maximum per-agent reconnect jitter in milliseconds.
pub const RETRY_JITTER_MS: u32 = 5_000;
/// Maximum connection handshake or heartbeat silence.
pub const READ_TIMEOUT: Duration = Duration::from_secs(75);
/// Interval between canonical freshness probes.
pub const PROGRESS_CHECK_INTERVAL: Duration = Duration::from_secs(30);
// Must exceed the largest chain's scraper indexing delay (reorgPeriod * block time)
// so the stream is not judged stale while the scraper is still confirming canonical
// blocks. Ethereum's ~15-block, ~12s-block reorg window is ~180s; 5 minutes leaves
// margin for replication lag and the probe interval, avoiding WebSocket/RPC flapping.
/// Sustained canonical lag tolerated before RPC fallback.
pub const PROGRESS_GRACE_PERIOD: Duration = Duration::from_secs(300);
/// Maximum duration of a canonical RPC probe.
pub const RPC_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
#[derive(Debug, thiserror::Error)]
#[error("Scraper-proxy rejected stream: {0}")]
/// A server rejection requiring a slower reconnect.
pub struct RejectedStream(pub String);

/// Choose the reconnect delay while RPC indexing remains active.
pub fn stream_retry_delay(result: &Result<()>, retry_delay: Duration) -> Duration {
    if result
        .as_ref()
        .err()
        .is_some_and(|err| err.downcast_ref::<RejectedStream>().is_some())
    {
        REJECTED_STREAM_RETRY_DELAY.saturating_add(retry_delay)
    } else {
        retry_delay
    }
}

/// Retry a failed session after the agent has restored RPC indexing.
/// Transport failures retry quickly; rejected subscriptions back off while RPC runs.
pub async fn reconnect_after(result: Result<()>, retry_delay: Duration) {
    let delay = stream_retry_delay(&result, retry_delay);
    match result {
        Ok(()) => tracing::warn!(
            ?delay,
            "Scraper WebSocket closed; reconnecting with RPC indexing active"
        ),
        Err(error) => tracing::warn!(
            ?error,
            ?delay,
            "Scraper WebSocket failed; reconnecting with RPC indexing active"
        ),
    }
    sleep(delay).await;
}

#[derive(Clone, Copy)]
/// Connection and freshness deadlines, overridable in tests.
pub struct StreamTimeouts {
    /// Maximum heartbeat silence.
    pub read: Duration,
    /// Canonical probe interval.
    pub progress_check: Duration,
    /// Sustained lag grace period.
    pub progress_grace: Duration,
}

impl Default for StreamTimeouts {
    fn default() -> Self {
        Self {
            read: READ_TIMEOUT,
            progress_check: PROGRESS_CHECK_INTERVAL,
            progress_grace: PROGRESS_GRACE_PERIOD,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
/// Protocol handshake state for one connection.
enum SubscriptionState {
    /// Waiting for server capabilities.
    AwaitingReady,
    /// Waiting for subscription acknowledgement.
    AwaitingSubscribed,
    /// Events and replay markers may be consumed.
    Subscribed,
}

impl SubscriptionState {
    /// Accept capabilities once.
    fn receive_ready(self) -> Result<Self> {
        match self {
            Self::AwaitingReady => Ok(Self::AwaitingSubscribed),
            Self::AwaitingSubscribed | Self::Subscribed => {
                bail!("Received duplicate WebSocket ready message")
            }
        }
    }

    /// Accept acknowledgement after capabilities.
    fn receive_subscribed(self) -> Result<Self> {
        match self {
            Self::AwaitingSubscribed => Ok(Self::Subscribed),
            Self::AwaitingReady => bail!("Received WebSocket subscribed message before ready"),
            Self::Subscribed => bail!("Received duplicate WebSocket subscribed message"),
        }
    }

    /// Reject data before subscription acknowledgement.
    fn require_subscribed(self, message_type: &str) -> Result<()> {
        if self != Self::Subscribed {
            bail!("Received WebSocket {message_type} before subscription acknowledgement");
        }
        Ok(())
    }
}

/// Canonical freshness and sustained-lag state for one sequenced stream.
/// Agents supply their durable next sequence and retain ownership of RPC tasks.
#[derive(Debug)]
pub struct StreamHealth {
    lag_started_at: Option<Instant>,
    grace: Duration,
}

impl Default for StreamHealth {
    fn default() -> Self {
        Self::new(PROGRESS_GRACE_PERIOD)
    }
}

impl StreamHealth {
    /// Use the same policy with an explicit grace interval (also useful in tests).
    pub fn new(grace: Duration) -> Self {
        Self {
            lag_started_at: None,
            grace,
        }
    }

    /// Whether this stream may use WebSocket indexing after a canonical probe.
    /// Startup requires equality; an active stream gets bounded lag tolerance.
    /// A rollback ahead of canonical state or expired lag requires RPC fallback.
    pub fn observe(&mut self, count: u32, next: u32, authoritative: bool) -> Result<bool> {
        check_stream_lag(
            &mut self.lag_started_at,
            count,
            next,
            self.grace,
            authoritative,
        )?;
        Ok(authoritative || count == next)
    }

    /// Reset on reconnect, loss of readiness, or the first completed replay.
    pub fn reset(&mut self) {
        self.lag_started_at = None;
    }

    /// Replay progress extends catch-up time. Live progress never hides lag.
    pub fn record_progress(&mut self, caught_up: bool) {
        if !caught_up {
            self.reset();
        }
    }
}

/// Reject rollback or sustained lag, preserving the timer across live events.
fn check_stream_lag(
    lag_started_at: &mut Option<Instant>,
    onchain_count: u32,
    next_sequence: u32,
    progress_grace: Duration,
    require_canonical_cursor: bool,
) -> Result<()> {
    if require_canonical_cursor && next_sequence > onchain_count {
        bail!(
            "Scraper WebSocket cursor rolled ahead of canonical count: next sequence {next_sequence}, on-chain count {onchain_count}"
        );
    }
    if onchain_count <= next_sequence {
        *lag_started_at = None;
        return Ok(());
    }
    let lag_started_at = lag_started_at.get_or_insert_with(Instant::now);
    if lag_started_at.elapsed() >= progress_grace {
        bail!(
            "Scraper WebSocket is stale: next sequence {next_sequence}, on-chain count {onchain_count}"
        );
    }
    Ok(())
}

/// Require an exact canonical count before replacing RPC indexing.
pub fn validate_cutover_freshness(onchain_count: u32, next_sequence: u32) -> Result<bool> {
    if next_sequence > onchain_count {
        bail!(
            "WebSocket cursor is ahead of canonical count: next sequence {next_sequence}, on-chain count {onchain_count}"
        );
    }
    Ok(next_sequence == onchain_count)
}

/// A single scraper connection. Callers own durable cursors and RPC indexers.
/// The read deadline survives cancellation of `recv` in an agent's select loop.
pub struct ScraperWebSocket {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    deadline: Pin<Box<Sleep>>,
    read_timeout: Duration,
    state: SubscriptionState,
}

impl ScraperWebSocket {
    /// Connect with a bounded handshake and start the heartbeat deadline.
    pub async fn connect(url: &url::Url, read_timeout: Duration) -> Result<Self> {
        let (socket, _) = timeout(read_timeout, connect_async(url.as_str()))
            .await
            .context("Connecting to scraper WebSocket timed out")?
            .context("Connecting to scraper WebSocket")?;
        Ok(Self {
            socket,
            deadline: Box::pin(sleep(read_timeout)),
            read_timeout,
            state: SubscriptionState::AwaitingReady,
        })
    }

    pub(super) fn read_deadline(&self) -> Instant {
        self.deadline.deadline()
    }

    /// Send the agent's cursor subscription after receiving `Ready`.
    pub async fn subscribe(&mut self, subscription: String) -> Result<()> {
        self.socket
            .send(Message::Text(subscription))
            .await
            .context("Subscribing to scraper WebSocket")
    }

    /// Receive a typed protocol message, servicing heartbeats and enforcing order.
    /// EOF and transport errors are returned to the agent so it restores RPC first.
    pub async fn recv<T: DeserializeOwned>(&mut self) -> Result<Option<ServerMessage<T>>> {
        loop {
            let frame = tokio::select! {
                biased;
                _ = &mut self.deadline => bail!("Scraper WebSocket heartbeat timed out"),
                frame = self.socket.next() => frame,
            };
            let Some(frame) = frame else {
                return Ok(None);
            };
            self.deadline.as_mut().reset(
                Instant::now()
                    .checked_add(self.read_timeout)
                    .expect("bounded read timeout"),
            );
            match frame.context("Reading scraper WebSocket message")? {
                Message::Text(text) => {
                    let message =
                        serde_json::from_str(&text).context("Parsing scraper WebSocket message")?;
                    match &message {
                        ServerMessage::Ready { .. } => self.state = self.state.receive_ready()?,
                        ServerMessage::Subscribed { .. } => {
                            self.state = self.state.receive_subscribed()?
                        }
                        ServerMessage::Event(_) => self.state.require_subscribed("event")?,
                        ServerMessage::CaughtUp { .. } => {
                            self.state.require_subscribed("caught-up marker")?
                        }
                        ServerMessage::Error { .. } | ServerMessage::Other => {}
                    }
                    return Ok(Some(message));
                }
                // Tungstenite queues the matching pong while reading a ping.
                // Flushing (rather than enqueueing another pong) survives recv cancellation.
                Message::Ping(_) => self
                    .socket
                    .flush()
                    .await
                    .context("Responding to scraper heartbeat")?,
                Message::Close(frame) => bail!("Scraper WebSocket closed: {frame:?}"),
                Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use eyre::eyre;

    #[test]
    fn subscription_state_requires_ordered_acknowledgement() {
        let awaiting_ready = SubscriptionState::AwaitingReady;
        assert!(awaiting_ready.receive_subscribed().is_err());
        assert!(awaiting_ready.require_subscribed("event").is_err());

        let awaiting_subscribed = awaiting_ready.receive_ready().expect("ready");
        assert_eq!(awaiting_subscribed, SubscriptionState::AwaitingSubscribed);
        assert!(awaiting_subscribed.receive_ready().is_err());
        assert!(awaiting_subscribed
            .require_subscribed("caught-up marker")
            .is_err());

        let subscribed = awaiting_subscribed
            .receive_subscribed()
            .expect("subscription acknowledgement");
        assert_eq!(subscribed, SubscriptionState::Subscribed);
        subscribed
            .require_subscribed("event")
            .expect("data allowed");
        assert!(subscribed.receive_ready().is_err());
        assert!(subscribed.receive_subscribed().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn backfill_progress_resets_lag_timer() {
        let grace = Duration::from_secs(10);
        let mut lag_started_at = None;

        check_stream_lag(&mut lag_started_at, 100, 1, grace, false).expect("initial lag");
        tokio::time::advance(Duration::from_secs(6)).await;
        lag_started_at = None;
        check_stream_lag(&mut lag_started_at, 102, 2, grace, false)
            .expect("first backfill progress");
        tokio::time::advance(Duration::from_secs(6)).await;
        lag_started_at = None;

        check_stream_lag(&mut lag_started_at, 104, 3, grace, false)
            .expect("continuous backfill remains healthy beyond one grace period");
    }

    #[test]
    fn rejected_streams_use_slow_retry_but_transport_errors_do_not() {
        let rejected =
            Err(RejectedStream("Failed to catch up merkle_tree_insertion".into()).into());
        assert_eq!(
            stream_retry_delay(&rejected, RETRY_DELAY),
            Duration::from_secs(305)
        );
        assert_eq!(
            stream_retry_delay(&Err(eyre!("connection reset")), RETRY_DELAY),
            RETRY_DELAY
        );
        assert_eq!(stream_retry_delay(&Ok(()), RETRY_DELAY), RETRY_DELAY);
    }
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    pub(crate) async fn connection(
        read: Duration,
    ) -> (ScraperWebSocket, WebSocketStream<TcpStream>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
        let url = url::Url::parse(&format!("ws://{}", listener.local_addr().expect("address")))
            .expect("URL");
        let (client, server) = tokio::join!(ScraperWebSocket::connect(&url, read), async {
            let (socket, _) = listener.accept().await.expect("accept client");
            accept_async(socket).await.expect("handshake")
        });
        (client.expect("connect"), server)
    }

    #[tokio::test]
    async fn heartbeat_is_serviced_without_hiding_protocol_messages() {
        let (mut client, mut server) = connection(Duration::from_secs(5)).await;
        server
            .send(Message::Ping(vec![1, 2, 3]))
            .await
            .expect("ping");
        server
            .send(Message::Text(r#"{"type":"ready"}"#.into()))
            .await
            .expect("ready");
        assert!(matches!(
            client.recv::<serde_json::Value>().await.expect("receive"),
            Some(ServerMessage::Ready { .. })
        ));
        let pong = timeout(Duration::from_secs(1), server.next())
            .await
            .expect("pong deadline")
            .expect("pong frame")
            .expect("pong");
        assert_eq!(pong, Message::Pong(vec![1, 2, 3]));
        client
            .subscribe(r#"{"type":"subscribe","streams":[]}"#.into())
            .await
            .expect("subscribe");
        assert!(matches!(
            server.next().await.expect("request").expect("frame"),
            Message::Text(_)
        ));
        server
            .send(Message::Text(
                r#"{"type":"subscribed","streams":[]}"#.into(),
            ))
            .await
            .expect("ack");
        assert!(matches!(
            client.recv::<serde_json::Value>().await.expect("ack"),
            Some(ServerMessage::Subscribed { .. })
        ));
        server.send(Message::Close(None)).await.expect("close");
        assert!(client.recv::<serde_json::Value>().await.is_err());
    }

    #[tokio::test]
    async fn cancelled_reads_keep_the_original_silence_deadline() {
        let (mut client, _server) = connection(Duration::from_secs(75)).await;
        tokio::time::pause();
        for _ in 0..2 {
            assert!(
                timeout(Duration::from_secs(30), client.recv::<serde_json::Value>())
                    .await
                    .is_err()
            );
        }
        let result = timeout(Duration::from_secs(20), client.recv::<serde_json::Value>())
            .await
            .expect("original deadline must win");
        assert!(result
            .expect_err("silence timeout")
            .to_string()
            .contains("heartbeat timed out"));
    }

    #[tokio::test]
    async fn rejects_malformed_messages_and_data_before_acknowledgement() {
        for text in [
            "{",
            r#"{"type":"subscribed","streams":[]}"#,
            r#"{"type":"event","domain":5,"eventType":"dispatch","data":{}}"#,
        ] {
            let (mut client, mut server) = connection(Duration::from_secs(1)).await;
            server
                .send(Message::Text(text.into()))
                .await
                .expect("send invalid frame");
            assert!(client.recv::<serde_json::Value>().await.is_err());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn live_lag_expires_despite_progress_and_catchup_resets_it() {
        let mut lag = None;
        check_stream_lag(&mut lag, 10, 9, PROGRESS_GRACE_PERIOD, true).expect("grace");
        tokio::time::advance(PROGRESS_GRACE_PERIOD).await;
        // Live progress does not reset lag.
        assert!(check_stream_lag(&mut lag, 12, 11, PROGRESS_GRACE_PERIOD, true).is_err());
        check_stream_lag(&mut lag, 12, 12, PROGRESS_GRACE_PERIOD, true).expect("recovered");
        assert!(lag.is_none());
        assert!(check_stream_lag(&mut lag, 11, 12, PROGRESS_GRACE_PERIOD, true).is_err());
    }
    #[tokio::test(start_paused = true)]
    async fn live_stream_still_fails_when_lag_grows() {
        let grace = Duration::from_secs(10);
        let mut health = StreamHealth::new(grace);

        health.observe(100, 1, false).expect("initial lag");
        tokio::time::advance(Duration::from_secs(5)).await;
        health.record_progress(true);
        health
            .observe(102, 2, false)
            .expect("progress within grace");
        tokio::time::advance(Duration::from_secs(5)).await;

        assert!(health.observe(104, 3, false).is_err());
    }
}
