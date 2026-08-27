use std::{sync::Arc, time::Duration};

use eyre::{bail, eyre, Context, Result};
use futures_util::{SinkExt, StreamExt};
use prometheus::IntGauge;
use serde::{Deserialize, Serialize};
use tokio::{
    task::JoinHandle,
    time::{interval, sleep, timeout, Instant, MissedTickBehavior},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, info_span, warn, Instrument};
use url::Url;

use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    settings::IndexSettings,
    ContractSyncer, SequencedDataContractSync,
};
use hyperlane_core::{
    bytes_to_address, IndexMode, Indexed, LogMeta, MerkleTreeHook, MerkleTreeInsertion,
    ReorgPeriod, H256,
};

const RETRY_DELAY: Duration = Duration::from_secs(5);
const RETRY_JITTER_MS: u32 = 5_000;
const READ_TIMEOUT: Duration = Duration::from_secs(75);
const PROGRESS_CHECK_INTERVAL: Duration = Duration::from_secs(30);
const PROGRESS_GRACE_PERIOD: Duration = Duration::from_secs(75);
const RPC_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const CANONICAL_RETRY_DELAY: Duration = Duration::from_secs(1);
const CANONICAL_FETCH_ATTEMPTS: usize = 3;
const EVENT_TYPE: &str = "merkle_tree_insertion";
const NEXT_SEQUENCE_KEY: &str = "merkle_tree_hook_websocket_next_sequence_";
// Bound crash recovery scans without writing the cursor for every replayed leaf.
const NEXT_SEQUENCE_PERSIST_INTERVAL: u32 = 256;

struct RpcFallback {
    handle: JoinHandle<()>,
    active: IntGauge,
}

#[derive(Clone)]
struct StreamDependencies {
    canonical_sync: Option<Arc<SequencedDataContractSync<MerkleTreeInsertion>>>,
    canonical_chunk_size: u32,
    index_mode: IndexMode,
    merkle_tree_hook: Option<Arc<dyn MerkleTreeHook>>,
    reorg_period: ReorgPeriod,
}

#[derive(Clone, Copy)]
struct StreamTimeouts {
    read: Duration,
    progress_check: Duration,
    progress_grace: Duration,
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

    /// Prefers scraper-proxy once it has reached the validator's current cursor.
    pub(crate) async fn run(
        self,
        next_sequence: u32,
        backfill_target: u32,
        fallback_sync: Arc<SequencedDataContractSync<MerkleTreeInsertion>>,
        index_settings: IndexSettings,
        merkle_tree_hook: Arc<dyn MerkleTreeHook>,
        reorg_period: ReorgPeriod,
    ) {
        let retry_delay = RETRY_DELAY
            .checked_add(Duration::from_millis(
                (self.domain % RETRY_JITTER_MS).into(),
            ))
            .expect("bounded retry jitter cannot overflow Duration");
        let dependencies = StreamDependencies {
            canonical_sync: Some(fallback_sync.clone()),
            canonical_chunk_size: index_settings.chunk_size,
            index_mode: index_settings.mode,
            merkle_tree_hook: Some(merkle_tree_hook),
            reorg_period,
        };
        self.run_loop(
            next_sequence,
            backfill_target,
            StreamTimeouts {
                read: READ_TIMEOUT,
                progress_check: PROGRESS_CHECK_INTERVAL,
                progress_grace: PROGRESS_GRACE_PERIOD,
            },
            retry_delay,
            dependencies,
            || {
                RpcFallback::start(
                    fallback_sync.clone(),
                    index_settings.clone(),
                    self.fallback_active.clone(),
                )
            },
        )
        .await;
    }

    async fn run_loop(
        &self,
        mut next_sequence: u32,
        backfill_target: u32,
        timeouts: StreamTimeouts,
        retry_delay: Duration,
        dependencies: StreamDependencies,
        mut start_fallback: impl FnMut() -> RpcFallback,
    ) {
        // Keep local indexing active until the WebSocket proves it has reached the
        // validator's cursor. A connected socket may still be queued for catch-up or
        // backed by a lagging scraper.
        let mut fallback = Some(start_fallback());
        loop {
            match self
                .stream_with_timeout(
                    &mut next_sequence,
                    backfill_target,
                    &mut fallback,
                    timeouts,
                    &dependencies,
                )
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
        backfill_target: u32,
        fallback: &mut Option<RpcFallback>,
        timeouts: StreamTimeouts,
        dependencies: &StreamDependencies,
    ) -> Result<()> {
        let (mut socket, _) = timeout(timeouts.read, connect_async(self.url.as_str()))
            .await
            .context("Connecting to Merkle tree hook WebSocket timed out")?
            .context("Connecting to Merkle tree hook WebSocket")?;
        let mut subscribed = false;
        let mut caught_up = false;
        let mut lag_started_at = None;
        let mut progress_checks = interval(timeouts.progress_check);
        progress_checks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        progress_checks.tick().await;
        let read_deadline = sleep(timeouts.read);
        tokio::pin!(read_deadline);
        let mut canonical_cache = Vec::new();

        loop {
            let message = tokio::select! {
                _ = &mut read_deadline => bail!("Merkle tree hook WebSocket heartbeat timed out"),
                message = socket.next() => Some(message),
                _ = progress_checks.tick(), if dependencies.merkle_tree_hook.is_some() => {
                    let hook = dependencies
                        .merkle_tree_hook
                        .as_ref()
                        .expect("progress check requires a Merkle tree hook");
                    tokio::select! {
                        _ = &mut read_deadline => {
                            bail!("Merkle tree hook WebSocket heartbeat timed out")
                        }
                        message = socket.next() => Some(message),
                        count = timeout(
                            RPC_PROBE_TIMEOUT,
                            hook.count(&dependencies.reorg_period),
                        ) => {
                            let onchain_count = count
                                .context("On-chain Merkle tree count probe timed out")?
                                .context("Reading on-chain Merkle tree count for WebSocket freshness")?;
                            check_stream_lag(
                                &mut lag_started_at,
                                onchain_count,
                                *next_sequence,
                                timeouts.progress_grace,
                            )?;
                            None
                        }
                    }
                }
            };
            let Some(message) = message else {
                continue;
            };
            let Some(message) = message else {
                break;
            };
            let next_read_deadline = Instant::now()
                .checked_add(timeouts.read)
                .expect("read timeout cannot exceed Instant range");
            read_deadline.as_mut().reset(next_read_deadline);
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
                        if *next_sequence < backfill_target {
                            info!(
                                domain = self.domain,
                                next_sequence = *next_sequence,
                                backfill_target,
                                "Backfilling Merkle tree hook WebSocket"
                            );
                        } else {
                            info!(
                                domain = self.domain,
                                next_sequence = *next_sequence,
                                "Subscribed to Merkle tree hook WebSocket"
                            );
                        }
                    }
                    ServerMessage::CaughtUp {
                        address,
                        domain,
                        event_type,
                        sequence,
                    } => {
                        let reached_cursor = self.validate_caught_up(
                            &address,
                            domain,
                            &event_type,
                            &sequence,
                            *next_sequence,
                        )?;
                        // Any valid, non-ahead marker proves historical replay has completed.
                        // A stale marker may still need live events to reach our local cursor.
                        caught_up = true;
                        if reached_cursor {
                            self.persist_next_sequence(*next_sequence)?;
                            lag_started_at = None;
                            if *next_sequence >= backfill_target {
                                self.activate_websocket(fallback).await;
                                info!(
                                    domain = self.domain,
                                    next_sequence = *next_sequence,
                                    "Caught up Merkle tree hook WebSocket"
                                );
                            } else {
                                warn!(
                                    domain = self.domain,
                                    next_sequence = *next_sequence,
                                    backfill_target,
                                    "Scraper-proxy caught up below validator startup cursor; keeping RPC fallback active"
                                );
                            }
                        } else {
                            warn!(
                                domain = self.domain,
                                next_sequence = *next_sequence,
                                scraper_sequence = sequence,
                                "Scraper-proxy is behind validator cursor; keeping RPC fallback active"
                            );
                        }
                    }
                    ServerMessage::Event(event) => {
                        if self
                            .process_event(event, next_sequence, dependencies, &mut canonical_cache)
                            .await?
                        {
                            // During historical replay, advancing events prove that the
                            // WebSocket is healthy. Only a lack of progress should trigger
                            // fallback; live-stream lag is checked after `caught_up`.
                            record_stream_progress(&mut lag_started_at, caught_up);
                            if caught_up && *next_sequence >= backfill_target {
                                self.activate_websocket(fallback).await;
                            }
                        }
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

    async fn activate_websocket(&self, fallback: &mut Option<RpcFallback>) {
        self.stop_fallback(fallback).await;
        self.websocket_active.set(1);
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

    /// Validates and stores an event, returning whether it advanced the cursor.
    ///
    /// New or changed leaves are verified against canonical RPC data before persistence.
    /// Exact duplicates reuse the previously verified local row without another RPC query.
    async fn process_event(
        &self,
        event: EventMessage,
        next_sequence: &mut u32,
        dependencies: &StreamDependencies,
        canonical_cache: &mut Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>,
    ) -> Result<bool> {
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

        let existing = self
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&leaf_index)?;
        let existing_block = if existing.is_some() {
            self.db
                .retrieve_merkle_tree_insertion_block_number_by_leaf_index(&leaf_index)?
        } else {
            None
        };
        if existing.as_ref() != Some(&insertion) || existing_block != Some(block_number) {
            self.validate_canonical_insertion(
                &insertion,
                block_number,
                dependencies,
                canonical_cache,
            )
            .await?;
        }

        match existing {
            Some(existing) if existing != insertion => {
                warn!(
                    domain = self.domain,
                    leaf_index,
                    ?existing,
                    canonical = ?insertion,
                    "Repairing conflicting Merkle tree insertion with canonical RPC data"
                );
                self.db.store_tree_insertion(&insertion, block_number)?;
            }
            Some(_) => {
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
            if next_sequence.is_multiple_of(NEXT_SEQUENCE_PERSIST_INTERVAL) {
                self.persist_next_sequence(*next_sequence)?;
            }
            return Ok(true);
        }
        Ok(false)
    }

    fn persist_next_sequence(&self, next_sequence: u32) -> Result<()> {
        self.db
            .store_value_by_key(NEXT_SEQUENCE_KEY, &false, &next_sequence)?;
        Ok(())
    }

    async fn validate_canonical_insertion(
        &self,
        insertion: &MerkleTreeInsertion,
        block_number: u64,
        dependencies: &StreamDependencies,
        canonical_cache: &mut Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>,
    ) -> Result<()> {
        let Some(canonical_sync) = &dependencies.canonical_sync else {
            return Ok(());
        };
        let query_position = match dependencies.index_mode {
            IndexMode::Block => block_number
                .try_into()
                .context("Merkle tree insertion block number exceeds u32")?,
            IndexMode::Sequence => insertion.index(),
        };

        for attempt in 0..=CANONICAL_FETCH_ATTEMPTS {
            if let Some(matches) = matches_canonical_insertion(
                insertion,
                block_number,
                query_position,
                dependencies.index_mode,
                canonical_cache,
            ) {
                if matches {
                    return Ok(());
                }
                bail!(
                    "WebSocket Merkle tree insertion at leaf {} conflicted with canonical RPC data",
                    insertion.index()
                );
            }
            if attempt == CANONICAL_FETCH_ATTEMPTS {
                break;
            }
            if attempt > 0 {
                sleep(CANONICAL_RETRY_DELAY).await;
            }
            let available_end = timeout(
                RPC_PROBE_TIMEOUT,
                canonical_sync.latest_indexed_position(dependencies.index_mode),
            )
            .await
            .context("Canonical Merkle tree insertion tip query timed out")?
            .context("Fetching canonical Merkle tree insertion tip")?;
            let Some(query_end) = canonical_query_end(
                query_position,
                dependencies.canonical_chunk_size,
                available_end,
            ) else {
                continue;
            };
            *canonical_cache = timeout(
                RPC_PROBE_TIMEOUT,
                canonical_sync.fetch_logs_in_range(query_position..=query_end),
            )
            .await
            .context("Canonical Merkle tree insertion query timed out")?
            .context("Fetching canonical Merkle tree insertion")?;
        }
        bail!(
            "Canonical RPC data is not yet available for Merkle tree insertion at leaf {}",
            insertion.index()
        )
    }

    fn validate_caught_up(
        &self,
        address: &str,
        domain: u32,
        event_type: &str,
        sequence: &str,
        next_sequence: u32,
    ) -> Result<bool> {
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
        Ok(sequence.checked_add(1) == Some(next_sequence))
    }
}

fn check_stream_lag(
    lag_started_at: &mut Option<Instant>,
    onchain_count: u32,
    next_sequence: u32,
    progress_grace: Duration,
) -> Result<()> {
    if onchain_count <= next_sequence {
        *lag_started_at = None;
        return Ok(());
    }
    let lag_started_at = lag_started_at.get_or_insert_with(Instant::now);
    if lag_started_at.elapsed() >= progress_grace {
        bail!(
            "Merkle tree hook WebSocket is stale: next sequence {next_sequence}, on-chain count {onchain_count}"
        );
    }
    Ok(())
}

fn record_stream_progress(lag_started_at: &mut Option<Instant>, caught_up: bool) {
    if !caught_up {
        *lag_started_at = None;
    }
}

fn canonical_query_end(
    query_position: u32,
    chunk_size: u32,
    available_end: Option<u32>,
) -> Option<u32> {
    let available_end = available_end?;
    (query_position <= available_end).then(|| {
        query_position
            .saturating_add(chunk_size.max(1).saturating_sub(1))
            .min(available_end)
    })
}

/// `None` means the requested position is not yet present in the fetched window.
fn matches_canonical_insertion(
    insertion: &MerkleTreeInsertion,
    block_number: u64,
    query_position: u32,
    index_mode: IndexMode,
    canonical_logs: &[(Indexed<MerkleTreeInsertion>, LogMeta)],
) -> Option<bool> {
    let mut logs_at_position = canonical_logs
        .iter()
        .filter(|(canonical, meta)| match index_mode {
            IndexMode::Block => meta.block_number == u64::from(query_position),
            IndexMode::Sequence => canonical.inner().index() == query_position,
        })
        .peekable();
    logs_at_position.peek()?;
    Some(logs_at_position.any(|(canonical, meta)| {
        canonical.inner() == insertion && meta.block_number == block_number
    }))
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

    use async_trait::async_trait;
    use futures_util::{future::pending, SinkExt, StreamExt};
    use hyperlane_base::db::{HyperlaneDb, DB};
    use hyperlane_core::{
        ChainResult, CheckpointAtBlock, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
        HyperlaneProvider, IncrementalMerkleAtBlock,
    };
    use prometheus::IntGauge;
    use tempfile::TempDir;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    use super::*;

    #[derive(Debug)]
    struct CountHook {
        count: Arc<AtomicUsize>,
        domain: HyperlaneDomain,
    }

    impl HyperlaneChain for CountHook {
        fn domain(&self) -> &HyperlaneDomain {
            &self.domain
        }

        fn provider(&self) -> Box<dyn HyperlaneProvider> {
            unreachable!("test count hook has no provider")
        }
    }

    impl HyperlaneContract for CountHook {
        fn address(&self) -> H256 {
            H256::from_low_u64_be(2)
        }
    }

    #[async_trait]
    impl MerkleTreeHook for CountHook {
        async fn tree(&self, _reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
            unreachable!("test only reads count")
        }

        async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
            Ok(self.count.load(Ordering::SeqCst) as u32)
        }

        async fn latest_checkpoint(
            &self,
            _reorg_period: &ReorgPeriod,
        ) -> ChainResult<CheckpointAtBlock> {
            unreachable!("test only reads count")
        }

        async fn latest_checkpoint_at_block(&self, _height: u64) -> ChainResult<CheckpointAtBlock> {
            unreachable!("test only reads count")
        }
    }

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

    fn test_dependencies() -> StreamDependencies {
        StreamDependencies {
            canonical_sync: None,
            canonical_chunk_size: 10,
            index_mode: IndexMode::Block,
            merkle_tree_hook: None,
            reorg_period: ReorgPeriod::None,
        }
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

    #[tokio::test]
    async fn checkpoints_next_sequence_and_recovers_uncheckpointed_tail() {
        let (sync, _temp_dir) = test_sync();
        let mut next_sequence = sync.next_sequence(0).expect("initialize sequence");
        let dependencies = test_dependencies();
        let mut canonical_cache = Vec::new();

        for sequence in 0_u32..257 {
            let event = EventMessage {
                data: EventData {
                    block_number: StringOrNumber::Number(u64::from(sequence)),
                    domain: 1,
                    leaf_index: StringOrNumber::Number(u64::from(sequence)),
                    merkle_tree_hook: format!("{:#x}", sync.merkle_tree_hook),
                    message_id: format!("{:#x}", H256::from_low_u64_be(u64::from(sequence))),
                },
                domain: 1,
                event_type: EVENT_TYPE.to_owned(),
                sequence: sequence.to_string(),
            };
            assert!(sync
                .process_event(
                    event,
                    &mut next_sequence,
                    &dependencies,
                    &mut canonical_cache,
                )
                .await
                .expect("valid event"));
        }

        let persisted: Option<u32> = sync
            .db
            .retrieve_value_by_key(NEXT_SEQUENCE_KEY, &false)
            .expect("retrieve persisted sequence");
        assert_eq!(persisted, Some(256));
        assert_eq!(next_sequence, 257);
        assert_eq!(sync.next_sequence(0).expect("recover sequence"), 257);
    }

    #[tokio::test]
    async fn stores_valid_event_and_rejects_sequence_gap() {
        let (sync, _temp_dir) = test_sync();
        let mut next_sequence = 0;
        let dependencies = test_dependencies();
        let mut canonical_cache = Vec::new();
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

        assert!(sync
            .process_event(
                event,
                &mut next_sequence,
                &dependencies,
                &mut canonical_cache,
            )
            .await
            .expect("valid event"));
        assert_eq!(next_sequence, 1);
        assert_eq!(
            sync.db
                .retrieve_merkle_tree_insertion_by_leaf_index(&0)
                .expect("retrieve insertion"),
            Some(MerkleTreeInsertion::new(0, H256::from_low_u64_be(4)))
        );
        assert!(!sync
            .process_event(
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
                &dependencies,
                &mut canonical_cache,
            )
            .await
            .expect("matching fallback insertion"));
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
        assert!(sync
            .process_event(gap, &mut next_sequence, &dependencies, &mut canonical_cache,)
            .await
            .is_err());
    }

    #[test]
    fn rejects_noncanonical_websocket_insertion() {
        let insertion = MerkleTreeInsertion::new(0, H256::from_low_u64_be(4));
        let canonical = MerkleTreeInsertion::new(0, H256::from_low_u64_be(5));
        let canonical_logs = [(
            Indexed::from(canonical),
            LogMeta {
                block_number: 12,
                ..Default::default()
            },
        )];

        assert_eq!(
            matches_canonical_insertion(&insertion, 12, 12, IndexMode::Block, &canonical_logs),
            Some(false)
        );
        assert_eq!(
            matches_canonical_insertion(&canonical, 13, 13, IndexMode::Block, &canonical_logs),
            None
        );
        assert_eq!(
            matches_canonical_insertion(&canonical, 12, 12, IndexMode::Block, &canonical_logs),
            Some(true)
        );
    }

    #[test]
    fn canonical_query_is_batched_and_tip_clamped() {
        assert_eq!(canonical_query_end(100, 1999, Some(150)), Some(150));
        assert_eq!(canonical_query_end(10, 1999, Some(19)), Some(19));
        assert_eq!(canonical_query_end(151, 1999, Some(150)), None);
    }

    #[tokio::test(start_paused = true)]
    async fn live_stream_still_fails_when_lag_grows() {
        let grace = Duration::from_secs(10);
        let mut lag_started_at = None;

        check_stream_lag(&mut lag_started_at, 100, 1, grace).expect("initial lag");
        tokio::time::advance(Duration::from_secs(5)).await;
        record_stream_progress(&mut lag_started_at, true);
        check_stream_lag(&mut lag_started_at, 102, 2, grace).expect("progress within grace");
        tokio::time::advance(Duration::from_secs(5)).await;

        assert!(check_stream_lag(&mut lag_started_at, 104, 3, grace).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn backfill_progress_resets_lag_timer() {
        let grace = Duration::from_secs(10);
        let mut lag_started_at = None;

        check_stream_lag(&mut lag_started_at, 100, 1, grace).expect("initial lag");
        tokio::time::advance(Duration::from_secs(6)).await;
        record_stream_progress(&mut lag_started_at, false);
        check_stream_lag(&mut lag_started_at, 102, 2, grace).expect("first backfill progress");
        tokio::time::advance(Duration::from_secs(6)).await;
        record_stream_progress(&mut lag_started_at, false);

        check_stream_lag(&mut lag_started_at, 104, 3, grace)
            .expect("continuous backfill remains healthy beyond one grace period");
    }

    #[tokio::test]
    async fn backfill_waits_for_marker_and_stale_marker_enables_live_handoff() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let (mut sync, _temp_dir) = test_sync();
        sync.url = Url::parse(&format!(
            "ws://{}",
            listener.local_addr().expect("test listener address")
        ))
        .expect("test WebSocket URL");
        let hook = format!("{:#x}", sync.merkle_tree_hook);
        let first_message_id = format!("{:#x}", H256::from_low_u64_be(4));
        let second_message_id = format!("{:#x}", H256::from_low_u64_be(5));
        let third_message_id = format!("{:#x}", H256::from_low_u64_be(6));
        let (continue_tx, continue_rx) = tokio::sync::oneshot::channel();
        let (caught_up_tx, caught_up_rx) = tokio::sync::oneshot::channel();
        let (live_tx, live_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("connection");
            let mut socket = accept_async(stream).await.expect("WebSocket");
            socket
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .expect("send ready message");
            socket
                .next()
                .await
                .expect("subscription message")
                .expect("read subscription message");
            socket
                .send(Message::Text(format!(
                    r#"{{"type":"event","data":{{"block_number":12,"domain":1,"leaf_index":1,"merkle_tree_hook":"{hook}","message_id":"{first_message_id}"}},"domain":1,"eventType":"merkle_tree_insertion","sequence":"1"}}"#
                )))
                .await
                .expect("send backfill event");
            continue_rx.await.expect("continue backfill");
            socket
                .send(Message::Text(format!(
                    r#"{{"type":"event","data":{{"block_number":13,"domain":1,"leaf_index":2,"merkle_tree_hook":"{hook}","message_id":"{second_message_id}"}},"domain":1,"eventType":"merkle_tree_insertion","sequence":"2"}}"#
                )))
                .await
                .expect("send final backfill event");
            caught_up_rx.await.expect("send caught-up marker");
            socket
                .send(Message::Text(format!(
                    r#"{{"type":"caught_up","address":"{hook}","domain":1,"eventType":"merkle_tree_insertion","sequence":"1"}}"#
                )))
                .await
                .expect("send caught-up marker");
            live_rx.await.expect("send live event");
            socket
                .send(Message::Text(format!(
                    r#"{{"type":"event","data":{{"block_number":14,"domain":1,"leaf_index":3,"merkle_tree_hook":"{hook}","message_id":"{third_message_id}"}},"domain":1,"eventType":"merkle_tree_insertion","sequence":"3"}}"#
                )))
                .await
                .expect("send live event");
            pending::<()>().await;
        });

        let active = sync.fallback_active.clone();
        let active_after_backfill = active.clone();
        let websocket_active = sync.websocket_active.clone();
        let db = sync.db.clone();
        let task = tokio::spawn(async move {
            sync.run_loop(
                1,
                3,
                StreamTimeouts {
                    read: Duration::from_secs(1),
                    progress_check: Duration::from_secs(1),
                    progress_grace: Duration::from_secs(1),
                },
                Duration::from_secs(1),
                test_dependencies(),
                move || {
                    active.set(1);
                    RpcFallback {
                        handle: tokio::spawn(pending()),
                        active: active.clone(),
                    }
                },
            )
            .await;
        });

        timeout(Duration::from_secs(1), async {
            while db
                .retrieve_merkle_tree_insertion_by_leaf_index(&1)
                .expect("retrieve first backfill insertion")
                .is_none()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first backfill insertion");
        assert_eq!(active_after_backfill.get(), 1);
        assert_eq!(websocket_active.get(), 0);

        continue_tx.send(()).expect("continue backfill");
        timeout(Duration::from_secs(1), async {
            while db
                .retrieve_merkle_tree_insertion_by_leaf_index(&2)
                .expect("retrieve final backfill insertion")
                .is_none()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("final backfill insertion");
        assert_eq!(active_after_backfill.get(), 1);
        assert_eq!(websocket_active.get(), 0);

        caught_up_tx.send(()).expect("send caught-up marker");
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert_eq!(active_after_backfill.get(), 1);
        assert_eq!(websocket_active.get(), 0);

        live_tx.send(()).expect("send live event");
        timeout(Duration::from_secs(1), async {
            while websocket_active.get() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("WebSocket received post-marker live event");
        assert_eq!(active_after_backfill.get(), 0);
        assert!(db
            .retrieve_merkle_tree_insertion_by_leaf_index(&3)
            .expect("retrieve live insertion")
            .is_some());
        task.abort();
    }

    #[test]
    fn only_accepts_caught_up_marker_at_validator_cursor() {
        let (sync, _temp_dir) = test_sync();
        let hook = format!("{:#x}", sync.merkle_tree_hook);

        assert!(sync
            .validate_caught_up(&hook, 1, EVENT_TYPE, "1", 2)
            .expect("marker at cursor"));
        assert!(!sync
            .validate_caught_up(&hook, 1, EVENT_TYPE, "0", 2)
            .expect("stale marker"));
        assert!(sync
            .validate_caught_up(&hook, 1, EVENT_TYPE, "2", 2)
            .is_err());
    }

    #[tokio::test]
    async fn falls_back_after_timeout_and_recovers() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let (mut sync, _temp_dir) = test_sync();
        sync.url = Url::parse(&format!(
            "ws://{}",
            listener.local_addr().expect("test listener address")
        ))
        .expect("test WebSocket URL");
        let hook = format!("{:#x}", sync.merkle_tree_hook);
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("first connection");
            let _silent = accept_async(stream).await.expect("first WebSocket");
            let (stream, _) = listener.accept().await.expect("second connection");
            let mut socket = accept_async(stream).await.expect("second WebSocket");
            socket
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .expect("send ready message");
            socket
                .next()
                .await
                .expect("subscription message")
                .expect("read subscription message");
            socket
                .send(Message::Text(format!(
                    r#"{{"type":"caught_up","address":"{hook}","domain":1,"eventType":"merkle_tree_insertion","sequence":"0"}}"#
                )))
                .await
                .expect("send caught-up message");
            pending::<()>().await;
        });

        let starts = Arc::new(AtomicUsize::new(0));
        let starts_in_fallback = starts.clone();
        let active = sync.fallback_active.clone();
        let active_in_fallback = active.clone();
        let db = sync.db.clone();
        let websocket_active = sync.websocket_active.clone();
        let websocket_active_after_recovery = websocket_active.clone();
        let task = tokio::spawn(async move {
            sync.run_loop(
                1,
                1,
                StreamTimeouts {
                    read: Duration::from_millis(10),
                    progress_check: Duration::from_secs(1),
                    progress_grace: Duration::from_secs(1),
                },
                Duration::from_millis(1),
                test_dependencies(),
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
            while starts.load(Ordering::SeqCst) != 1
                || active.get() != 0
                || websocket_active_after_recovery.get() != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fallback recovery");
        task.abort();
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(active.get(), 0);
        assert_eq!(websocket_active.get(), 1);
        let persisted: Option<u32> = db
            .retrieve_value_by_key(NEXT_SEQUENCE_KEY, &false)
            .expect("retrieve persisted sequence");
        assert_eq!(persisted, Some(1));
    }

    #[tokio::test]
    async fn heartbeat_only_stream_falls_back_when_onchain_count_advances() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let (mut sync, _temp_dir) = test_sync();
        sync.url = Url::parse(&format!(
            "ws://{}",
            listener.local_addr().expect("test listener address")
        ))
        .expect("test WebSocket URL");
        let hook_address = format!("{:#x}", sync.merkle_tree_hook);
        let onchain_count = Arc::new(AtomicUsize::new(1));
        let server_count = onchain_count.clone();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("connection");
            let mut socket = accept_async(stream).await.expect("WebSocket");
            socket
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .expect("send ready message");
            socket
                .next()
                .await
                .expect("subscription message")
                .expect("read subscription message");
            socket
                .send(Message::Text(format!(
                    r#"{{"type":"caught_up","address":"{hook_address}","domain":1,"eventType":"merkle_tree_insertion","sequence":"0"}}"#
                )))
                .await
                .expect("send caught-up message");
            server_count.store(2, Ordering::SeqCst);
            let mut heartbeats = interval(Duration::from_millis(2));
            loop {
                heartbeats.tick().await;
                if socket
                    .send(Message::Text(r#"{"type":"heartbeat"}"#.into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });

        let starts = Arc::new(AtomicUsize::new(0));
        let starts_in_fallback = starts.clone();
        let active = sync.fallback_active.clone();
        let active_in_fallback = active.clone();
        let websocket_active = sync.websocket_active.clone();
        let websocket_active_after_stale = websocket_active.clone();
        let dependencies = StreamDependencies {
            merkle_tree_hook: Some(Arc::new(CountHook {
                count: onchain_count,
                domain: HyperlaneDomain::new_test_domain("count-hook"),
            })),
            ..test_dependencies()
        };
        let task = tokio::spawn(async move {
            sync.run_loop(
                1,
                1,
                StreamTimeouts {
                    read: Duration::from_millis(50),
                    progress_check: Duration::from_millis(5),
                    progress_grace: Duration::from_millis(10),
                },
                Duration::from_secs(1),
                dependencies,
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
            while starts.load(Ordering::SeqCst) != 2
                || active.get() != 1
                || websocket_active_after_stale.get() != 0
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stale data fallback");
        task.abort();
    }
}
