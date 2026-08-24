use std::{sync::Arc, time::Duration};

use eyre::{bail, eyre, Context, Result};
use futures_util::{SinkExt, StreamExt};
use prometheus::IntGauge;
use serde::{Deserialize, Serialize};
use tokio::{
    task::JoinHandle,
    time::{sleep, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, info_span, warn, Instrument};
use url::Url;

use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    settings::IndexSettings,
    ContractSyncer, SequencedDataContractSync,
};
use hyperlane_core::{bytes_to_address, MerkleTreeInsertion, H256};

const RETRY_DELAY: Duration = Duration::from_secs(5);
const RETRY_JITTER_MS: u32 = 5_000;
const READ_TIMEOUT: Duration = Duration::from_secs(75);
const EVENT_TYPE: &str = "merkle_tree_insertion";
const NEXT_SEQUENCE_KEY: &str = "merkle_tree_hook_websocket_next_sequence_";

struct RpcFallback {
    handle: JoinHandle<()>,
    active: IntGauge,
}

impl RpcFallback {
    fn start(
        sync: Arc<SequencedDataContractSync<MerkleTreeInsertion>>,
        index_settings: IndexSettings,
        active: IntGauge,
    ) -> Self {
        let domain = sync.domain().name().to_owned();
        let handle = tokio::spawn(
            async move {
                loop {
                    match sync.cursor(index_settings.clone()).await {
                        Ok(cursor) => {
                            let label = "merkle_tree_hook";
                            sync.clone().sync(label, cursor.into()).await;
                            warn!(chain = domain, label, "RPC fallback sync task exit");
                        }
                        Err(err) => {
                            warn!(?err, chain = domain, "Failed to create RPC fallback cursor")
                        }
                    }
                    sleep(RETRY_DELAY).await;
                }
            }
            .instrument(info_span!("MerkleTreeHookRpcFallback")),
        );
        active.set(1);
        Self { handle, active }
    }

    async fn stop(mut self) {
        self.handle.abort();
        if let Err(err) = (&mut self.handle).await {
            if !err.is_cancelled() {
                warn!(?err, "RPC fallback sync task failed while stopping");
            }
        }
        self.active.set(0);
    }
}

impl Drop for RpcFallback {
    fn drop(&mut self) {
        self.handle.abort();
        self.active.set(0);
    }
}

/// Streams Merkle tree insertions from scraper-proxy into the validator database.
#[derive(Clone, Debug)]
pub(crate) struct MerkleTreeHookWebSocketSync {
    db: HyperlaneRocksDB,
    domain: u32,
    merkle_tree_hook: H256,
    url: Url,
    websocket_active: IntGauge,
    fallback_active: IntGauge,
}

impl MerkleTreeHookWebSocketSync {
    pub(crate) fn new(
        db: HyperlaneRocksDB,
        domain: u32,
        merkle_tree_hook: H256,
        url: Url,
        websocket_active: IntGauge,
        fallback_active: IntGauge,
    ) -> Self {
        websocket_active.set(0);
        fallback_active.set(0);
        Self {
            db,
            domain,
            merkle_tree_hook,
            url,
            websocket_active,
            fallback_active,
        }
    }

    /// Returns the first missing leaf, using the on-chain tree count to initialize the cursor.
    pub(crate) fn next_sequence(&self, hint: u32) -> Result<u32> {
        let stored: Option<u32> = self.db.retrieve_value_by_key(NEXT_SEQUENCE_KEY, &false)?;
        match stored {
            Some(sequence) => self.next_sequence_from(sequence),
            None => self.initialize_sequence(hint),
        }
    }

    fn initialize_sequence(&self, high: u32) -> Result<u32> {
        // RPC backfills may be sparse, so scan until the first gap once during migration.
        let mut sequence = 0;
        while sequence < high
            && self
                .db
                .retrieve_merkle_tree_insertion_by_leaf_index(&sequence)?
                .is_some()
        {
            sequence = sequence.checked_add(1).expect("sequence is below high");
        }
        self.db
            .store_value_by_key(NEXT_SEQUENCE_KEY, &false, &sequence)?;
        Ok(sequence)
    }

    fn next_sequence_from(&self, mut sequence: u32) -> Result<u32> {
        while self
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&sequence)?
            .is_some()
        {
            sequence = sequence
                .checked_add(1)
                .ok_or_else(|| eyre!("Merkle tree insertion sequence exhausted"))?;
        }
        self.db
            .store_value_by_key(NEXT_SEQUENCE_KEY, &false, &sequence)?;
        Ok(sequence)
    }

    /// Prefers scraper-proxy, running local RPC indexing only while the WebSocket is unavailable.
    pub(crate) async fn run(
        self,
        next_sequence: u32,
        fallback_sync: Arc<SequencedDataContractSync<MerkleTreeInsertion>>,
        index_settings: IndexSettings,
    ) {
        let retry_delay = RETRY_DELAY
            .checked_add(Duration::from_millis(
                (self.domain % RETRY_JITTER_MS).into(),
            ))
            .expect("bounded retry jitter cannot overflow Duration");
        self.run_loop(next_sequence, READ_TIMEOUT, retry_delay, || {
            RpcFallback::start(
                fallback_sync.clone(),
                index_settings.clone(),
                self.fallback_active.clone(),
            )
        })
        .await;
    }

    async fn run_loop(
        &self,
        mut next_sequence: u32,
        read_timeout: Duration,
        retry_delay: Duration,
        mut start_fallback: impl FnMut() -> RpcFallback,
    ) {
        let mut fallback = None;
        loop {
            match self
                .stream_with_timeout(&mut next_sequence, &mut fallback, read_timeout)
                .await
            {
                Ok(()) => warn!(
                    domain = self.domain,
                    "Merkle tree hook WebSocket closed; reconnecting"
                ),
                Err(err) => warn!(
                    ?err,
                    domain = self.domain,
                    "Merkle tree hook WebSocket failed; reconnecting"
                ),
            }
            self.websocket_active.set(0);
            if fallback.is_none() {
                fallback = Some(start_fallback());
                warn!(
                    domain = self.domain,
                    "Switched Merkle tree hook indexing to RPC fallback"
                );
            }
            sleep(retry_delay).await;
        }
    }

    async fn stream_with_timeout(
        &self,
        next_sequence: &mut u32,
        fallback: &mut Option<RpcFallback>,
        read_timeout: Duration,
    ) -> Result<()> {
        let (mut socket, _) = timeout(read_timeout, connect_async(self.url.as_str()))
            .await
            .context("Connecting to Merkle tree hook WebSocket timed out")?
            .context("Connecting to Merkle tree hook WebSocket")?;
        let mut subscribed = false;

        while let Some(message) = timeout(read_timeout, socket.next())
            .await
            .context("Merkle tree hook WebSocket heartbeat timed out")?
        {
            match message.context("Reading Merkle tree hook WebSocket message")? {
                Message::Text(text) => match serde_json::from_str::<ServerMessage>(&text)
                    .context("Parsing Merkle tree hook WebSocket message")?
                {
                    ServerMessage::Ready => {
                        if subscribed {
                            bail!("Received duplicate WebSocket ready message");
                        }
                        socket
                            .send(Message::Text(self.subscription(*next_sequence)?))
                            .await
                            .context("Subscribing to Merkle tree hook insertions")?;
                        subscribed = true;
                    }
                    ServerMessage::Subscribed => {
                        self.websocket_active.set(1);
                        info!(
                            domain = self.domain,
                            next_sequence = *next_sequence,
                            "Subscribed to Merkle tree hook WebSocket"
                        );
                    }
                    ServerMessage::CaughtUp {
                        address,
                        domain,
                        event_type,
                        sequence,
                    } => {
                        self.validate_caught_up(
                            &address,
                            domain,
                            &event_type,
                            &sequence,
                            *next_sequence,
                        )?;
                        self.stop_fallback(fallback).await;
                        info!(
                            domain = self.domain,
                            next_sequence = *next_sequence,
                            "Caught up Merkle tree hook WebSocket"
                        );
                    }
                    ServerMessage::Event(event) => {
                        self.stop_fallback(fallback).await;
                        self.process_event(event, next_sequence)?;
                    }
                    ServerMessage::Error { error } => {
                        bail!("Scraper-proxy rejected Merkle tree hook stream: {error}")
                    }
                    ServerMessage::Other => {}
                },
                Message::Ping(payload) => socket
                    .send(Message::Pong(payload))
                    .await
                    .context("Responding to Merkle tree hook WebSocket heartbeat")?,
                Message::Close(frame) => {
                    bail!("Merkle tree hook WebSocket closed: {frame:?}")
                }
                Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
        }
        Ok(())
    }

    async fn stop_fallback(&self, fallback: &mut Option<RpcFallback>) {
        if let Some(task) = fallback.take() {
            task.stop().await;
            info!(
                domain = self.domain,
                "Switched Merkle tree hook indexing back to WebSocket"
            );
        }
    }

    fn subscription(&self, next_sequence: u32) -> Result<String> {
        let after_sequence = next_sequence.checked_sub(1).map(i64::from).unwrap_or(-1);
        serde_json::to_string(&SubscribeMessage {
            streams: [SubscribeStream {
                cursors: [SequenceCursor {
                    address: format!("{:#x}", self.merkle_tree_hook),
                    allow_replay: true,
                    after_sequence: after_sequence.to_string(),
                    domain: self.domain,
                }],
                domains: [self.domain],
                event_type: EVENT_TYPE,
            }],
            message_type: "subscribe",
        })
        .context("Serializing Merkle tree hook WebSocket subscription")
    }

    fn process_event(&self, event: EventMessage, next_sequence: &mut u32) -> Result<()> {
        if event.event_type != EVENT_TYPE {
            bail!("Unexpected WebSocket event type {}", event.event_type);
        }
        if event.domain != self.domain || event.data.domain != self.domain {
            bail!(
                "Unexpected Merkle tree insertion domain: expected {}, received {}/{}",
                self.domain,
                event.domain,
                event.data.domain
            );
        }

        let leaf_index = event.data.leaf_index.as_u32("leaf_index")?;
        let sequence = event.sequence.parse::<u32>().with_context(|| {
            format!("Invalid Merkle tree insertion sequence {}", event.sequence)
        })?;
        if sequence != leaf_index || leaf_index > *next_sequence {
            bail!(
                "Unexpected Merkle tree insertion sequence: expected {}, received {sequence}/{leaf_index}",
                *next_sequence
            );
        }

        let merkle_tree_hook = parse_address(&event.data.merkle_tree_hook)?;
        if merkle_tree_hook != self.merkle_tree_hook {
            bail!(
                "Unexpected Merkle tree hook address: expected {:#x}, received {:#x}",
                self.merkle_tree_hook,
                merkle_tree_hook
            );
        }

        let message_id = parse_h256(&event.data.message_id)?;
        let block_number = event.data.block_number.as_u64("block_number")?;
        let insertion = MerkleTreeInsertion::new(leaf_index, message_id);

        match self
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&leaf_index)?
        {
            Some(existing) if existing != insertion => {
                bail!("Conflicting Merkle tree insertion at leaf {leaf_index}")
            }
            Some(_) => {
                let existing_block = self
                    .db
                    .retrieve_merkle_tree_insertion_block_number_by_leaf_index(&leaf_index)?;
                if existing_block != Some(block_number) {
                    self.db.store_tree_insertion(&insertion, block_number)?;
                }
            }
            None => {
                self.db.store_tree_insertion(&insertion, block_number)?;
            }
        }

        if leaf_index == *next_sequence {
            *next_sequence = next_sequence
                .checked_add(1)
                .ok_or_else(|| eyre!("Merkle tree insertion sequence exhausted"))?;
            self.db
                .store_value_by_key(NEXT_SEQUENCE_KEY, &false, next_sequence)?;
        }
        Ok(())
    }

    fn validate_caught_up(
        &self,
        address: &str,
        domain: u32,
        event_type: &str,
        sequence: &str,
        next_sequence: u32,
    ) -> Result<()> {
        if domain != self.domain
            || event_type != EVENT_TYPE
            || parse_address(address)? != self.merkle_tree_hook
        {
            bail!("Unexpected Merkle tree hook caught-up marker");
        }
        let sequence = sequence
            .parse::<u32>()
            .context("Invalid caught-up sequence")?;
        if sequence >= next_sequence {
            bail!("Caught-up marker skipped Merkle tree insertions");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeMessage<'a> {
    streams: [SubscribeStream<'a>; 1],
    #[serde(rename = "type")]
    message_type: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeStream<'a> {
    cursors: [SequenceCursor; 1],
    domains: [u32; 1],
    event_type: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SequenceCursor {
    address: String,
    allow_replay: bool,
    after_sequence: String,
    domain: u32,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    Ready,
    Subscribed,
    #[serde(rename_all = "camelCase")]
    CaughtUp {
        address: String,
        domain: u32,
        event_type: String,
        sequence: String,
    },
    Event(EventMessage),
    Error {
        error: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventMessage {
    data: EventData,
    domain: u32,
    event_type: String,
    sequence: String,
}

#[derive(Debug, Deserialize)]
struct EventData {
    block_number: StringOrNumber,
    domain: u32,
    leaf_index: StringOrNumber,
    merkle_tree_hook: String,
    message_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum StringOrNumber {
    String(String),
    Number(u64),
}

impl StringOrNumber {
    fn as_u32(&self, field: &str) -> Result<u32> {
        let value = self.as_u64(field)?;
        value
            .try_into()
            .with_context(|| format!("{field} exceeds u32"))
    }

    fn as_u64(&self, field: &str) -> Result<u64> {
        match self {
            Self::String(value) => value
                .parse()
                .with_context(|| format!("Invalid {field} value {value}")),
            Self::Number(value) => Ok(*value),
        }
    }
}

fn parse_address(value: &str) -> Result<H256> {
    bytes_to_address(parse_hex(value)?).context("Invalid Merkle tree hook address")
}

fn parse_h256(value: &str) -> Result<H256> {
    let bytes = parse_hex(value)?;
    if bytes.len() != 32 {
        bail!("Invalid message ID length {}", bytes.len());
    }
    Ok(H256::from_slice(&bytes))
}

fn parse_hex(value: &str) -> Result<Vec<u8>> {
    let value = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("\\x"))
        .unwrap_or(value);
    hex::decode(value).context("Invalid hexadecimal WebSocket event field")
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use futures_util::{future::pending, SinkExt, StreamExt};
    use hyperlane_base::db::{HyperlaneDb, DB};
    use hyperlane_core::HyperlaneDomain;
    use prometheus::IntGauge;
    use tempfile::TempDir;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    use super::*;

    fn test_sync() -> (MerkleTreeHookWebSocketSync, TempDir) {
        let temp_dir = tempfile::tempdir().expect("temp directory");
        let db = HyperlaneRocksDB::new(
            &HyperlaneDomain::new_test_domain("websocket-sync"),
            DB::from_path(temp_dir.path()).expect("test database"),
        );
        (
            MerkleTreeHookWebSocketSync::new(
                db,
                1,
                H256::from_low_u64_be(2),
                Url::parse("ws://localhost/agents").expect("test URL"),
                IntGauge::new("test_websocket_active", "test").expect("test gauge"),
                IntGauge::new("test_fallback_active", "test").expect("test gauge"),
            ),
            temp_dir,
        )
    }

    #[test]
    fn subscribes_after_last_contiguous_leaf() {
        let (sync, _temp_dir) = test_sync();
        sync.db
            .store_tree_insertion(&MerkleTreeInsertion::new(1, H256::from_low_u64_be(4)), 11)
            .expect("store insertion after gap");
        sync.db
            .store_tree_insertion(&MerkleTreeInsertion::new(2, H256::from_low_u64_be(5)), 12)
            .expect("store insertion after gap");

        assert_eq!(sync.next_sequence(3).expect("next sequence"), 0);
        sync.db
            .store_tree_insertion(&MerkleTreeInsertion::new(0, H256::from_low_u64_be(3)), 10)
            .expect("fill insertion gap");
        assert_eq!(sync.next_sequence(3).expect("cached next sequence"), 3);
        let subscription: serde_json::Value =
            serde_json::from_str(&sync.subscription(3).expect("subscription"))
                .expect("subscription JSON");
        assert_eq!(
            subscription["streams"][0]["cursors"][0]["afterSequence"],
            "2"
        );
    }

    #[test]
    fn stores_valid_event_and_rejects_sequence_gap() {
        let (sync, _temp_dir) = test_sync();
        let mut next_sequence = 0;
        let event = EventMessage {
            data: EventData {
                block_number: StringOrNumber::String("12".to_owned()),
                domain: 1,
                leaf_index: StringOrNumber::Number(0),
                merkle_tree_hook: format!("{:#x}", sync.merkle_tree_hook),
                message_id: format!("{:#x}", H256::from_low_u64_be(4)),
            },
            domain: 1,
            event_type: EVENT_TYPE.to_owned(),
            sequence: "0".to_owned(),
        };

        sync.process_event(event, &mut next_sequence)
            .expect("valid event");
        assert_eq!(next_sequence, 1);
        assert_eq!(
            sync.db
                .retrieve_merkle_tree_insertion_by_leaf_index(&0)
                .expect("retrieve insertion"),
            Some(MerkleTreeInsertion::new(0, H256::from_low_u64_be(4)))
        );
        sync.process_event(
            EventMessage {
                data: EventData {
                    block_number: StringOrNumber::Number(13),
                    domain: 1,
                    leaf_index: StringOrNumber::Number(0),
                    merkle_tree_hook: format!("{:#x}", sync.merkle_tree_hook),
                    message_id: format!("{:#x}", H256::from_low_u64_be(4)),
                },
                domain: 1,
                event_type: EVENT_TYPE.to_owned(),
                sequence: "0".to_owned(),
            },
            &mut next_sequence,
        )
        .expect("matching fallback insertion");
        assert_eq!(next_sequence, 1);
        assert_eq!(
            sync.db
                .retrieve_merkle_tree_insertion_block_number_by_leaf_index(&0)
                .expect("retrieve insertion block"),
            Some(13)
        );

        let gap = EventMessage {
            data: EventData {
                block_number: StringOrNumber::Number(13),
                domain: 1,
                leaf_index: StringOrNumber::Number(2),
                merkle_tree_hook: format!("{:#x}", sync.merkle_tree_hook),
                message_id: format!("{:#x}", H256::from_low_u64_be(5)),
            },
            domain: 1,
            event_type: EVENT_TYPE.to_owned(),
            sequence: "2".to_owned(),
        };
        assert!(sync.process_event(gap, &mut next_sequence).is_err());
    }

    #[tokio::test]
    async fn falls_back_after_timeout_and_recovers() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let (mut sync, _temp_dir) = test_sync();
        sync.url = Url::parse(&format!("ws://{}", listener.local_addr().unwrap())).unwrap();
        let hook = format!("{:#x}", sync.merkle_tree_hook);
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _silent = accept_async(stream).await.unwrap();
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            socket
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .unwrap();
            socket.next().await.unwrap().unwrap();
            socket
                .send(Message::Text(format!(
                    r#"{{"type":"caught_up","address":"{hook}","domain":1,"eventType":"merkle_tree_insertion","sequence":"0"}}"#
                )))
                .await
                .unwrap();
            pending::<()>().await;
        });

        let starts = Arc::new(AtomicUsize::new(0));
        let starts_in_fallback = starts.clone();
        let active = sync.fallback_active.clone();
        let active_in_fallback = active.clone();
        let task = tokio::spawn(async move {
            sync.run_loop(
                1,
                Duration::from_millis(10),
                Duration::from_millis(1),
                move || {
                    active_in_fallback.set(1);
                    starts_in_fallback.fetch_add(1, Ordering::SeqCst);
                    RpcFallback {
                        handle: tokio::spawn(pending()),
                        active: active_in_fallback.clone(),
                    }
                },
            )
            .await;
        });

        timeout(Duration::from_secs(1), async {
            while starts.load(Ordering::SeqCst) != 1 || active.get() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fallback recovery");
        task.abort();
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(active.get(), 0);
    }
}
