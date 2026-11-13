use std::{collections::BTreeMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use eyre::{bail, eyre, Context, ContextCompat, Result};
use futures_util::{future::BoxFuture, stream, FutureExt, StreamExt};
use prometheus::IntGauge;
use tokio::{
    sync::Notify,
    task::JoinHandle,
    time::{interval, sleep, timeout, MissedTickBehavior},
};
use tracing::{info, info_span, warn, Instrument};
use url::Url;

use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    scraper_websocket::{
        parse_address, reconnect_after, EventMessage, MerkleEventData as EventData, RejectedStream,
        ScraperSession, ServerMessage, SessionEvent, StreamHealth, StreamTimeouts,
        SubscribeMessage, SubscribeStream, RETRY_DELAY, RETRY_JITTER_MS, RPC_PROBE_TIMEOUT,
    },
    settings::IndexSettings,
    ContractSyncer, SequencedDataContractSync,
};
use hyperlane_core::{
    BackwardCursorProgress, HyperlaneBackwardCursorStore, HyperlaneLogStore,
    HyperlaneSequenceAwareIndexerStoreReader, IndexMode, Indexed, LogMeta, MerkleTreeHook,
    MerkleTreeInsertion, ReorgPeriod, H256,
};
use hyperlane_metric::rpc_operation::{with_rpc_operation, RpcOperation};
use redact::Secret;

const EVENT_TYPE: &str = "merkle_tree_insertion";
const MAX_HANDOFF_INSERTIONS: usize = 4_096;
const HANDOFF_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Explicit RPC fallback for a batch that failed checkpoint verification. Never
/// trusts websocket block numbers to choose the recovery range.
#[derive(Clone)]
pub(crate) struct MerkleTreeRpcRecovery {
    pub(crate) sync: Arc<SequencedDataContractSync<MerkleTreeInsertion>>,
    pub(crate) db: HyperlaneRocksDB,
    pub(crate) index_settings: IndexSettings,
    /// A previously verified checkpoint's block, inclusive (it may contain new leaves).
    pub(crate) from_block: Option<u64>,
}

/// In-memory scan state survives cancellation at the resampling deadline.
#[derive(Default)]
pub(crate) struct RecoveryProgress {
    first_sequence: Option<u32>,
    next: Option<u32>,
    leaves: BTreeMap<u32, (Indexed<MerkleTreeInsertion>, LogMeta)>,
}

impl MerkleTreeRpcRecovery {
    pub(crate) async fn fetch_insertions(
        &self,
        first_sequence: u32,
        checkpoint: &hyperlane_core::CheckpointAtBlock,
    ) -> Result<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let leaves = self
            .fetch_insertions_with_progress(
                first_sequence,
                checkpoint,
                &mut RecoveryProgress::default(),
            )
            .await?;
        let expected_count = u64::from(
            checkpoint
                .index
                .checked_sub(first_sequence)
                .context("RPC recovery range starts after its target checkpoint")?,
        )
        .saturating_add(1);
        if u64::try_from(leaves.len())? != expected_count {
            bail!("RPC fallback did not return every insertion in the unverified batch");
        }
        Ok(leaves)
    }

    pub(crate) async fn fetch_insertions_with_progress(
        &self,
        first_sequence: u32,
        checkpoint: &hyperlane_core::CheckpointAtBlock,
        progress: &mut RecoveryProgress,
    ) -> Result<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        if progress.first_sequence != Some(first_sequence) {
            *progress = RecoveryProgress {
                first_sequence: Some(first_sequence),
                ..Default::default()
            };
        }
        let (mut start, end) = match self.index_settings.mode {
            IndexMode::Block => {
                // Tag-based checkpoint reads may not return a height. Resolve a
                // finalized scan boundary only after entering RPC recovery. The
                // recovered leaves must still reproduce the captured checkpoint.
                let end = match checkpoint.block_height {
                    Some(height) => u32::try_from(height)?,
                    None => timeout(
                        RPC_PROBE_TIMEOUT,
                        self.sync.latest_indexed_position(IndexMode::Block),
                    )
                    .await
                    .context("Resolving RPC recovery height timed out")??
                    .context("RPC indexer did not return a finalized height")?,
                };
                let configured_start = if self.index_settings.from < 0 {
                    i64::from(end)
                        .saturating_add(self.index_settings.from)
                        .max(0)
                } else {
                    self.index_settings.from
                };
                (
                    self.from_block
                        .map(u32::try_from)
                        .transpose()?
                        .unwrap_or(u32::try_from(configured_start)?),
                    end,
                )
            }
            IndexMode::Sequence => (first_sequence, checkpoint.index),
        };
        start = progress.next.unwrap_or(start);
        while start <= end {
            let batch_end = start
                .saturating_add(self.index_settings.chunk_size.saturating_sub(1))
                .min(end);
            // Retry only the failed range; completed ranges and recovered leaves
            // remain in memory until this captured checkpoint is verified.
            let logs = loop {
                let result = timeout(
                    RPC_PROBE_TIMEOUT,
                    with_rpc_operation(
                        RpcOperation::ContractSync,
                        self.sync.fetch_logs_in_range(start..=batch_end),
                    ),
                )
                .await
                .context("RPC fallback checkpoint recovery timed out")
                .and_then(|result| result.map_err(Into::into));
                match result {
                    Ok(logs) => break logs,
                    Err(error) => {
                        warn!(?error, start, batch_end, "Retrying RPC recovery range");
                        sleep(hyperlane_core::rpc_clients::RPC_RETRY_SLEEP_DURATION).await;
                    }
                }
            };
            for (insertion, meta) in logs {
                let index = insertion.inner().index();
                if index >= first_sequence {
                    if let Some((existing, _)) = progress.leaves.insert(index, (insertion, meta)) {
                        if existing != insertion {
                            bail!("RPC fallback returned conflicting leaves at index {index}");
                        }
                    }
                }
            }
            progress.next = batch_end.checked_add(1);
            if batch_end == end {
                break;
            }
            start = progress.next.expect("batch end is below the target");
        }
        // Return the available contiguous prefix. A minority may advertise leaves
        // that do not exist; only the caller's endpoint vote can authorize repair.
        let mut next = first_sequence;
        Ok(progress
            .leaves
            .range(first_sequence..=checkpoint.index)
            .take_while(|(index, _)| {
                let contiguous = **index == next;
                next = next.saturating_add(1);
                contiguous
            })
            .map(|(_, leaf)| leaf.clone())
            .collect())
    }

    pub(crate) fn store_verified_insertions(
        &self,
        leaves: &[(Indexed<MerkleTreeInsertion>, LogMeta)],
    ) -> Result<()> {
        for (insertion, meta) in leaves {
            self.db
                .store_tree_insertion(insertion.inner(), meta.block_number)?;
        }
        Ok(())
    }
}

/// Adds checkpoint wakeups to the ordinary RPC log store.
#[derive(Clone, Debug)]
pub(crate) struct MerkleTreeStore {
    db: HyperlaneRocksDB,
    checkpoint_wake: Option<Arc<Notify>>,
}

impl MerkleTreeStore {
    pub(crate) fn new(db: HyperlaneRocksDB, checkpoint_wake: Option<Arc<Notify>>) -> Self {
        Self {
            db,
            checkpoint_wake,
        }
    }
}

#[async_trait]
impl HyperlaneLogStore<MerkleTreeInsertion> for MerkleTreeStore {
    async fn store_logs(&self, leaves: &[(Indexed<MerkleTreeInsertion>, LogMeta)]) -> Result<u32> {
        let insertions = self.db.store_logs(leaves).await?;
        if insertions > 0 {
            if let Some(wake) = &self.checkpoint_wake {
                wake.notify_one();
            }
        }
        Ok(insertions)
    }
}

#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<MerkleTreeInsertion> for MerkleTreeStore {
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<MerkleTreeInsertion>> {
        Ok(self
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&sequence)?)
    }

    async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> Result<Option<u64>> {
        Ok(self
            .db
            .retrieve_merkle_tree_insertion_block_number_by_leaf_index(&sequence)?)
    }
}

#[async_trait]
impl HyperlaneBackwardCursorStore<MerkleTreeInsertion> for MerkleTreeStore {
    async fn retrieve_backward_cursors(&self) -> Result<Vec<BackwardCursorProgress>> {
        HyperlaneBackwardCursorStore::<MerkleTreeInsertion>::retrieve_backward_cursors(&self.db)
            .await
    }

    async fn store_backward_cursor(&self, progress: BackwardCursorProgress) -> Result<()> {
        HyperlaneBackwardCursorStore::<MerkleTreeInsertion>::store_backward_cursor(
            &self.db, progress,
        )
        .await
    }

    async fn reset_backward_cursor(&self, progress: BackwardCursorProgress) -> Result<()> {
        HyperlaneBackwardCursorStore::<MerkleTreeInsertion>::reset_backward_cursor(
            &self.db, progress,
        )
        .await
    }

    async fn delete_backward_cursor(&self, sequence: u32) -> Result<()> {
        HyperlaneBackwardCursorStore::<MerkleTreeInsertion>::delete_backward_cursor(
            &self.db, sequence,
        )
        .await
    }
}

struct RpcFallback {
    handle: JoinHandle<()>,
    active: IntGauge,
}

#[derive(Clone)]
struct StreamDependencies {
    merkle_tree_hook: Arc<dyn MerkleTreeHook>,
    reorg_period: ReorgPeriod,
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
    url: Secret<Url>,
    confirmations: Option<u32>,
    websocket_active: IntGauge,
    fallback_active: IntGauge,
    checkpoint_wake: Arc<Notify>,
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
            url: Secret::new(url),
            confirmations: None,
            websocket_active,
            fallback_active,
            checkpoint_wake: Arc::new(Notify::new()),
        }
    }

    pub(crate) fn checkpoint_wake(&self) -> Arc<Notify> {
        self.checkpoint_wake.clone()
    }

    /// RPC reconstructs history; the socket only supplies live insertions.
    pub(crate) async fn run(
        mut self,
        next_sequence: u32,
        startup_count: u32,
        fallback_sync: Arc<SequencedDataContractSync<MerkleTreeInsertion>>,
        index_settings: IndexSettings,
        merkle_tree_hook: Arc<dyn MerkleTreeHook>,
        reorg_period: ReorgPeriod,
    ) {
        // Block tags retain the scraper's canonical confirmation policy.
        self.confirmations = reorg_period.as_blocks().ok();
        let retry_delay = RETRY_DELAY
            .checked_add(Duration::from_millis(
                (self.domain % RETRY_JITTER_MS).into(),
            ))
            .expect("bounded retry jitter cannot overflow Duration");
        self.run_loop(
            next_sequence,
            startup_count,
            StreamTimeouts::default(),
            retry_delay,
            StreamDependencies {
                merkle_tree_hook,
                reorg_period,
            },
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
        startup_count: u32,
        timeouts: StreamTimeouts,
        retry_delay: Duration,
        dependencies: StreamDependencies,
        mut start_fallback: impl FnMut() -> RpcFallback,
    ) {
        let mut fallback = Some(start_fallback());
        loop {
            let result = self
                .stream_with_timeout(
                    &mut next_sequence,
                    startup_count,
                    &mut fallback,
                    timeouts,
                    &dependencies,
                )
                .await;
            self.websocket_active.set(0);
            if fallback
                .as_ref()
                .is_none_or(|task| task.handle.is_finished())
            {
                if let Some(task) = fallback.take() {
                    task.stop().await;
                }
                fallback = Some(start_fallback());
                warn!(
                    domain = self.domain,
                    "Switched Merkle tree hook indexing to RPC fallback"
                );
            }
            reconnect_after(result, retry_delay).await;
        }
    }

    async fn stream_with_timeout(
        &self,
        next_sequence: &mut u32,
        startup_count: u32,
        fallback: &mut Option<RpcFallback>,
        timeouts: StreamTimeouts,
        dependencies: &StreamDependencies,
    ) -> Result<()> {
        let mut socket =
            ScraperSession::<_, ()>::connect(self.url.expose_secret(), timeouts).await?;
        let mut pending = BTreeMap::new();
        let mut health = StreamHealth::new(timeouts.progress_grace);
        let mut handoff_poll = interval(HANDOFF_POLL_INTERVAL);
        handoff_poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            let sequence = *next_sequence;
            let event = tokio::select! {
                _ = handoff_poll.tick(), if fallback.is_some() => {
                    self.try_handoff(next_sequence, startup_count, fallback, &mut pending).await?;
                    continue;
                }
                event = socket.next::<EventData>(fallback.is_none(), || {
                    let probe = count_probe(dependencies, RPC_PROBE_TIMEOUT);
                    stream::once(async move { (sequence, probe.await) }).boxed()
                }) => event?,
            };
            let Some(event) = event else {
                return Ok(());
            };
            let message = match event {
                SessionEvent::Message(message) => message,
                SessionEvent::Cutover { .. } => continue,
                SessionEvent::Progress((sequence, count)) => {
                    let count = count?;
                    if count_sample_is_stale(sequence, *next_sequence, count) {
                        continue;
                    }
                    if *next_sequence > count {
                        if !health.observe_probe_failure() {
                            bail!("WebSocket insertion cursor remained ahead of canonical count");
                        }
                    } else {
                        health.observe(count, *next_sequence, false)?;
                    }
                    continue;
                }
            };
            match message {
                ServerMessage::Ready { .. } => socket.subscribe(self.subscription()).await?,
                ServerMessage::Subscribed { .. } => {
                    info!(
                        domain = self.domain,
                        "Subscribed to live Merkle tree insertions; waiting for RPC overlap"
                    );
                }
                ServerMessage::Event(event) => {
                    let Some((insertion, block_number)) = self.decode_event(event)? else {
                        continue;
                    };
                    if fallback.is_some() {
                        // A restored snapshot may cover old leaves absent from the local DB.
                        if insertion.index() < *next_sequence
                            && self
                                .db
                                .retrieve_merkle_tree_insertion_by_leaf_index(&insertion.index())?
                                .is_none()
                        {
                            continue;
                        }
                        buffer_insertion(&mut pending, insertion, block_number)?;
                        self.try_handoff(next_sequence, startup_count, fallback, &mut pending)
                            .await?;
                    } else {
                        self.store_insertion(insertion, block_number, next_sequence)?;
                    }
                }
                ServerMessage::Error { error } => return Err(RejectedStream(error).into()),
                ServerMessage::Rollback => {
                    bail!("Scraper stream rolled back; resuming RPC indexing")
                }
                // Live subscriptions never depend on a replay marker.
                ServerMessage::CaughtUp { .. } | ServerMessage::Other => {}
            }
        }
    }

    async fn try_handoff(
        &self,
        next_sequence: &mut u32,
        startup_count: u32,
        fallback: &mut Option<RpcFallback>,
        pending: &mut BTreeMap<u32, (MerkleTreeInsertion, u64)>,
    ) -> Result<()> {
        let Some(task) = fallback.as_ref() else {
            return Ok(());
        };
        if task.handle.is_finished() {
            bail!("RPC fallback indexing task exited; restarting recovery");
        }
        // Only RPC has written the buffered range. Its cursor covers a contiguous
        // prefix from the authenticated snapshot, never just the highest stored row.
        let Some((&anchor, (insertion, _))) = pending.first_key_value() else {
            return Ok(());
        };
        *next_sequence = load_contiguous_sequence(self.db.clone(), *next_sequence).await?;
        if *next_sequence < startup_count || *next_sequence <= anchor {
            return Ok(());
        }
        let existing = self
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&anchor)?;
        if existing != Some(*insertion) {
            bail!("RPC and WebSocket disagree at handoff leaf {anchor}");
        }
        // Await cancellation before admitting socket writes. RPC may have advanced
        // beyond the anchor while its task was stopping; deduplicate that overlap.
        if let Some(task) = fallback.take() {
            task.stop().await;
        }
        *next_sequence = load_contiguous_sequence(self.db.clone(), *next_sequence).await?;
        while let Some((_, (insertion, block_number))) = pending.pop_first() {
            self.store_insertion(insertion, block_number, next_sequence)?;
        }
        self.websocket_active.set(1);
        info!(
            domain = self.domain,
            anchor,
            next_sequence = *next_sequence,
            "RPC overlap verified; switched Merkle tree hook indexing to WebSocket"
        );
        Ok(())
    }

    fn subscription(&self) -> SubscribeMessage<'static> {
        SubscribeMessage {
            streams: vec![SubscribeStream {
                confirmations: self.confirmations,
                cursors: None,
                domains: Some(vec![self.domain]),
                event_type: EVENT_TYPE,
                stream_cursor_version: None,
            }],
            message_type: "subscribe",
        }
    }

    fn decode_event(
        &self,
        event: EventMessage<EventData>,
    ) -> Result<Option<(MerkleTreeInsertion, u64)>> {
        if event.event_type != EVENT_TYPE {
            bail!("Unexpected WebSocket event type {}", event.event_type);
        }
        if event.row_id.is_some()
            || event.stream_cursor.is_some()
            || event.legacy_max_stream_cursor.is_some()
        {
            bail!("Merkle tree insertion unexpectedly included a row/stream cursor");
        }
        if event.domain != self.domain {
            bail!("Unexpected Merkle tree insertion domain {}", event.domain);
        }
        // Cursorless streams include all hooks in this domain.
        if parse_address(&event.data.merkle_tree_hook)? != self.merkle_tree_hook {
            return Ok(None);
        }
        let sequence = event
            .sequence
            .as_deref()
            .context("Missing Merkle tree insertion sequence")?
            .parse::<u32>()
            .context("Invalid Merkle tree insertion sequence")?;
        Ok(Some(event.data.decode(
            self.domain,
            self.merkle_tree_hook,
            sequence,
        )?))
    }

    fn store_insertion(
        &self,
        insertion: MerkleTreeInsertion,
        block_number: u64,
        next_sequence: &mut u32,
    ) -> Result<()> {
        let leaf_index = insertion.index();
        if leaf_index > *next_sequence {
            bail!(
                "Unexpected Merkle tree insertion sequence: expected {}, received {leaf_index}",
                *next_sequence
            );
        }
        // A snapshot authenticates the prefix root, not individual old event payloads.
        // Compare locally known duplicates, but never fill snapshot-covered holes.
        if leaf_index < *next_sequence {
            if let Some(existing) = self
                .db
                .retrieve_merkle_tree_insertion_by_leaf_index(&leaf_index)?
            {
                if existing != insertion {
                    bail!("Conflicting WebSocket Merkle tree insertion at leaf {leaf_index}");
                }
            }
            return Ok(());
        }
        if let Some(existing) = self
            .db
            .store_tree_insertion_if_absent(&insertion, block_number)?
        {
            if existing != insertion {
                bail!("Conflicting WebSocket Merkle tree insertion at leaf {leaf_index}");
            }
        }
        *next_sequence = next_sequence
            .checked_add(1)
            .ok_or_else(|| eyre!("Merkle tree insertion sequence exhausted"))?;
        // Indexing never authorizes signatures; independent root verification does.
        self.checkpoint_wake.notify_one();
        Ok(())
    }
}

pub(crate) async fn load_contiguous_sequence(db: HyperlaneRocksDB, sequence: u32) -> Result<u32> {
    tokio::task::spawn_blocking(move || contiguous_sequence(&db, sequence))
        .await
        .context("Finding the next Merkle tree insertion sequence")?
}

pub(crate) fn contiguous_sequence(db: &HyperlaneRocksDB, mut sequence: u32) -> Result<u32> {
    while db
        .retrieve_merkle_tree_insertion_by_leaf_index(&sequence)?
        .is_some()
    {
        sequence = sequence
            .checked_add(1)
            .ok_or_else(|| eyre!("Merkle tree insertion sequence exhausted"))?;
    }
    Ok(sequence)
}

fn count_sample_is_stale(sampled_sequence: u32, next_sequence: u32, count: u32) -> bool {
    next_sequence > sampled_sequence && next_sequence > count
}

fn count_probe(
    dependencies: &StreamDependencies,
    probe_timeout: Duration,
) -> BoxFuture<'static, Result<u32>> {
    let hook = dependencies.merkle_tree_hook.clone();
    let reorg_period = dependencies.reorg_period.clone();
    async move {
        timeout(probe_timeout, hook.count(&reorg_period))
            .await
            .context("On-chain Merkle tree count probe timed out")?
            .context("Reading on-chain Merkle tree count for WebSocket freshness")
    }
    .boxed()
}

fn buffer_insertion(
    pending: &mut BTreeMap<u32, (MerkleTreeInsertion, u64)>,
    insertion: MerkleTreeInsertion,
    block_number: u64,
) -> Result<()> {
    let index = insertion.index();
    if let Some((existing, _)) = pending.get(&index) {
        if existing != &insertion {
            bail!("Conflicting buffered insertion at leaf {index}");
        }
        return Ok(());
    }
    if let Some((&last, _)) = pending.last_key_value() {
        if last.checked_add(1) != Some(index) {
            bail!(
                "Gap in live Merkle stream: expected {}, received {index}",
                u64::from(last).saturating_add(1)
            );
        }
    }
    if pending.len() >= MAX_HANDOFF_INSERTIONS {
        bail!("Merkle handoff buffer limit exceeded; retaining RPC indexing");
    }
    pending.insert(index, (insertion, block_number));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::mock_merkle_tree_hook::MockMerkleTreeHook;
    use futures_util::{future::pending, SinkExt};
    use hyperlane_base::db::DB;
    use hyperlane_base::scraper_websocket::StringOrNumber;
    use hyperlane_core::HyperlaneDomain;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tempfile::TempDir;
    use tokio::{net::TcpListener, sync::mpsc};
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    fn test_sync() -> (MerkleTreeHookWebSocketSync, TempDir) {
        let directory = tempfile::tempdir().expect("test operation");
        let db = HyperlaneRocksDB::new(
            &HyperlaneDomain::new_test_domain("handoff"),
            DB::from_path(directory.path()).expect("test operation"),
        );
        (
            MerkleTreeHookWebSocketSync::new(
                db,
                1,
                H256::from_low_u64_be(2),
                Url::parse("ws://localhost/agents").expect("test operation"),
                IntGauge::new("websocket_active", "test").expect("test operation"),
                IntGauge::new("rpc_active", "test").expect("test operation"),
            ),
            directory,
        )
    }
    fn test_fallback(active: &IntGauge) -> RpcFallback {
        active.set(1);
        RpcFallback {
            handle: tokio::spawn(pending()),
            active: active.clone(),
        }
    }
    fn leaf(index: u32) -> MerkleTreeInsertion {
        MerkleTreeInsertion::new(
            index,
            H256::from_low_u64_be(u64::from(index).saturating_add(4)),
        )
    }
    fn event(index: u32) -> EventMessage<EventData> {
        EventMessage {
            data: EventData {
                block_number: StringOrNumber::Number(u64::from(index).saturating_add(10)),
                domain: 1,
                leaf_index: StringOrNumber::Number(u64::from(index)),
                merkle_tree_hook: format!("{:#x}", H256::from_low_u64_be(2)),
                message_id: format!("{:#x}", leaf(index).message_id()),
            },
            domain: 1,
            event_type: EVENT_TYPE.to_owned(),
            sequence: Some(index.to_string()),
            row_id: None,
            stream_cursor: None,
            legacy_max_stream_cursor: None,
        }
    }
    async fn write_rpc(sync: &MerkleTreeHookWebSocketSync, indices: std::ops::RangeInclusive<u32>) {
        let store = MerkleTreeStore::new(sync.db.clone(), Some(sync.checkpoint_wake.clone()));
        let logs = indices
            .map(|i| {
                (
                    Indexed::from(leaf(i)),
                    LogMeta {
                        block_number: u64::from(i).saturating_add(10),
                        ..Default::default()
                    },
                )
            })
            .collect::<Vec<_>>();
        store.store_logs(&logs).await.expect("test operation");
    }
    async fn wait_until(mut predicate: impl FnMut() -> bool) {
        timeout(Duration::from_secs(10), async {
            while !predicate() {
                sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("test operation");
    }

    #[test]
    fn subscriptions_are_live_only_for_numeric_and_canonical_finality() {
        let (mut sync, _directory) = test_sync();
        for confirmations in [None, Some(0), Some(3)] {
            sync.confirmations = confirmations;
            let value = serde_json::to_value(sync.subscription()).expect("test operation");
            let stream = &value["streams"][0];
            assert!(stream.get("cursors").is_none());
            assert_eq!(stream["domains"], serde_json::json!([1]));
            assert_eq!(stream["eventType"], EVENT_TYPE);
            if let Some(count) = confirmations {
                assert_eq!(stream["confirmations"], count);
            } else {
                assert!(stream.get("confirmations").is_none());
            }
        }
    }

    #[tokio::test]
    async fn fixed_overlap_waits_for_rpc_then_drains_a_moving_live_tail() {
        let (sync, _directory) = test_sync();
        let mut next = contiguous_sequence(&sync.db, 0).expect("test operation");
        let mut fallback = Some(test_fallback(&sync.fallback_active));
        let mut buffer = BTreeMap::new();
        for i in 10..=20 {
            buffer_insertion(&mut buffer, leaf(i), u64::from(i).saturating_add(10))
                .expect("test operation");
        }
        sync.try_handoff(&mut next, 10, &mut fallback, &mut buffer)
            .await
            .expect("test operation");
        assert!(fallback.is_some());
        assert!(sync
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&10)
            .expect("test operation")
            .is_none());
        write_rpc(&sync, 0..=10).await;
        // The live head is already 20, but matching the fixed anchor 10 is enough.
        sync.try_handoff(&mut next, 10, &mut fallback, &mut buffer)
            .await
            .expect("test operation");
        assert!(fallback.is_none());
        assert_eq!(sync.websocket_active.get(), 1);
        assert_eq!(sync.fallback_active.get(), 0);
        assert_eq!(next, 21);
        assert!(buffer.is_empty());
        sync.store_insertion(leaf(21), 31, &mut next)
            .expect("test operation");
        assert_eq!(next, 22);
    }

    #[tokio::test]
    async fn highest_stored_row_cannot_hide_a_missing_rpc_prefix() {
        let (sync, _directory) = test_sync();
        let mut next = contiguous_sequence(&sync.db, 0).expect("test operation");
        let mut fallback = Some(test_fallback(&sync.fallback_active));
        write_rpc(&sync, 5..=5).await;
        let mut buffer = BTreeMap::from([(5, (leaf(5), 15))]);
        sync.try_handoff(&mut next, 0, &mut fallback, &mut buffer)
            .await
            .expect("test operation");
        assert!(fallback.is_some());
        assert_eq!(next, 0);
        write_rpc(&sync, 0..=4).await;
        sync.try_handoff(&mut next, 0, &mut fallback, &mut buffer)
            .await
            .expect("test operation");
        assert!(fallback.is_none());
        assert_eq!(next, 6);
    }

    #[tokio::test]
    async fn handoff_preserves_startup_floor_and_rejects_rpc_conflicts() {
        let (sync, _directory) = test_sync();
        let mut next = contiguous_sequence(&sync.db, 0).expect("test operation");
        let mut fallback = Some(test_fallback(&sync.fallback_active));
        write_rpc(&sync, 0..=2).await;
        let mut buffer = BTreeMap::from([(2, (leaf(2), 12))]);
        sync.try_handoff(&mut next, 4, &mut fallback, &mut buffer)
            .await
            .expect("test operation");
        assert!(fallback.is_some());
        sync.db
            .store_tree_insertion(&MerkleTreeInsertion::new(2, H256::repeat_byte(9)), 12)
            .expect("test operation");
        assert!(sync
            .try_handoff(&mut next, 0, &mut fallback, &mut buffer)
            .await
            .is_err());
        assert!(fallback.is_some());
        assert_eq!(sync.websocket_active.get(), 0);
    }

    #[tokio::test]
    async fn rpc_progress_past_the_anchor_is_deduplicated_without_overwriting() {
        let (sync, _directory) = test_sync();
        let mut next = contiguous_sequence(&sync.db, 0).expect("test operation");
        let mut fallback = Some(test_fallback(&sync.fallback_active));
        write_rpc(&sync, 0..=8).await;
        let mut buffer = BTreeMap::new();
        for i in 4..=10 {
            buffer_insertion(&mut buffer, leaf(i), 999).expect("test operation");
        }
        sync.try_handoff(&mut next, 0, &mut fallback, &mut buffer)
            .await
            .expect("test operation");
        assert_eq!(next, 11);
        assert_eq!(
            sync.db
                .retrieve_merkle_tree_insertion_block_number_by_leaf_index(&8)
                .expect("test operation"),
            Some(18)
        );
        assert_eq!(
            sync.db
                .retrieve_merkle_tree_insertion_block_number_by_leaf_index(&9)
                .expect("test operation"),
            Some(999)
        );
        assert!(sync
            .store_insertion(MerkleTreeInsertion::new(8, H256::zero()), 0, &mut next)
            .is_err());
        assert!(sync.store_insertion(leaf(12), 0, &mut next).is_err());
    }

    #[test]
    fn handoff_buffer_bounds_duplicates_conflicts_and_gaps() {
        let mut buffer = BTreeMap::new();
        for i in 0..u32::try_from(MAX_HANDOFF_INSERTIONS).expect("test operation") {
            buffer_insertion(&mut buffer, leaf(i), 10).expect("test operation");
        }
        buffer_insertion(&mut buffer, leaf(0), 10).expect("test operation");
        assert!(
            buffer_insertion(&mut buffer, MerkleTreeInsertion::new(0, H256::zero()), 10).is_err()
        );
        assert!(buffer_insertion(
            &mut buffer,
            leaf(u32::try_from(MAX_HANDOFF_INSERTIONS).expect("test operation")),
            10
        )
        .is_err());
        assert_eq!(buffer.len(), MAX_HANDOFF_INSERTIONS);
        let mut buffer = BTreeMap::new();
        buffer_insertion(&mut buffer, leaf(5), 10).expect("test operation");
        assert!(buffer_insertion(&mut buffer, leaf(7), 10).is_err());
    }

    #[test]
    fn live_events_filter_other_hooks_and_validate_envelopes() {
        let (sync, _directory) = test_sync();
        assert_eq!(
            sync.decode_event(event(0)).expect("test operation"),
            Some((leaf(0), 10))
        );
        let mut foreign = event(0);
        foreign.data.merkle_tree_hook = format!("{:#x}", H256::repeat_byte(3));
        assert!(sync
            .decode_event(foreign)
            .expect("test operation")
            .is_none());
        let mut invalid = event(0);
        invalid.domain = 2;
        assert!(sync.decode_event(invalid).is_err());
        let mut invalid = event(0);
        invalid.sequence = Some("1".into());
        assert!(sync.decode_event(invalid).is_err());
        let mut invalid = event(0);
        invalid.stream_cursor = Some("1".into());
        assert!(sync.decode_event(invalid).is_err());
    }

    #[test]
    fn historical_event_cannot_populate_a_snapshot_covered_hole() {
        let (sync, _directory) = test_sync();
        let mut next = 10; // The authenticated snapshot covers this prefix.
        sync.store_insertion(leaf(3), 13, &mut next)
            .expect("ignore old insertion");
        assert_eq!(next, 10);
        assert!(sync
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&3)
            .expect("read old leaf")
            .is_none());
        assert!(sync.checkpoint_wake.notified().now_or_never().is_none());
    }

    #[tokio::test]
    async fn snapshot_cursor_recovers_only_a_contiguous_local_tail() {
        let (sync, _directory) = test_sync();
        write_rpc(&sync, 10..=11).await;
        write_rpc(&sync, 13..=13).await;
        assert_eq!(
            contiguous_sequence(&sync.db, 10).expect("test operation"),
            12
        );
        // Losing the snapshot must not reuse its skipped prefix.
        assert_eq!(contiguous_sequence(&sync.db, 0).expect("test operation"), 0);
    }

    #[tokio::test]
    async fn fallback_panic_disconnect_and_sequence_gap_restore_rpc_and_require_new_overlap() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test operation");
        let (mut sync, _directory) = test_sync();
        sync.url = Url::parse(&format!(
            "ws://{}/agents",
            listener.local_addr().expect("test operation")
        ))
        .expect("test operation")
        .into();
        contiguous_sequence(&sync.db, 0).expect("test operation");
        write_rpc(&sync, 0..=0).await;
        let writer = sync.clone();
        let active = sync.websocket_active.clone();
        let rpc_active = sync.fallback_active.clone();
        let starts = Arc::new(AtomicUsize::new(0));
        let started = starts.clone();
        let count = Arc::new(AtomicUsize::new(1));
        let mut hook = MockMerkleTreeHook::new();
        let observed_count = count.clone();
        hook.expect_count().returning(move |_| {
            Ok(u32::try_from(observed_count.load(Ordering::SeqCst)).expect("test count"))
        });
        let hook = Arc::new(hook);
        let (frames, mut receiver) = mpsc::channel::<Message>(16);
        let subscriptions = Arc::new(AtomicUsize::new(0));
        let connected = subscriptions.clone();
        let server = tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.expect("test operation");
                let mut socket = accept_async(tcp).await.expect("test operation");
                socket
                    .send(Message::Text(r#"{"type":"ready"}"#.into()))
                    .await
                    .expect("test operation");
                let request = socket
                    .next()
                    .await
                    .expect("test operation")
                    .expect("test operation");
                let mut ack: serde_json::Value =
                    serde_json::from_str(request.to_text().expect("test operation"))
                        .expect("test operation");
                assert!(ack["streams"][0].get("cursors").is_none());
                ack["type"] = "subscribed".into();
                socket
                    .send(Message::Text(ack.to_string().into()))
                    .await
                    .expect("test operation");
                connected.fetch_add(1, Ordering::SeqCst);
                loop {
                    tokio::select! {
                        frame = receiver.recv() => {
                            let Some(frame) = frame else { return; };
                            let close = matches!(frame, Message::Close(_));
                            if socket.send(frame).await.is_err() || close { break; }
                        }
                        incoming = socket.next() => { if !matches!(incoming, Some(Ok(_))) { break; } }
                    }
                }
            }
        });
        let crash = Arc::new(Notify::new());
        let crash_task = crash.clone();
        let task = tokio::spawn(async move {
            sync.run_loop(
                1,
                1,
                StreamTimeouts {
                    read: Duration::from_secs(3600),
                    progress_check: Duration::from_millis(10),
                    progress_grace: Duration::from_secs(5),
                },
                Duration::from_millis(1),
                StreamDependencies {
                    merkle_tree_hook: hook,
                    reorg_period: ReorgPeriod::None,
                },
                || {
                    if started.fetch_add(1, Ordering::SeqCst) == 0 {
                        let crash = crash_task.clone();
                        sync.fallback_active.set(1);
                        RpcFallback {
                            handle: tokio::spawn(async move {
                                crash.notified().await;
                                panic!("injected RPC fallback panic");
                            }),
                            active: sync.fallback_active.clone(),
                        }
                    } else {
                        test_fallback(&sync.fallback_active)
                    }
                },
            )
            .await;
        });
        let frame = |i: u32| {
            Message::Text(serde_json::json!({ "type": "event", "eventType": EVENT_TYPE, "domain": 1,
            "sequence": i.to_string(), "data": { "block_number": i.saturating_add(10), "domain": 1, "leaf_index": i,
            "merkle_tree_hook": format!("{:#x}", H256::from_low_u64_be(2)), "message_id": format!("{:#x}", leaf(i).message_id()) } }).to_string().into())
        };
        wait_until(|| subscriptions.load(Ordering::SeqCst) == 1).await;
        // No buffered anchor is needed to detect and replace a failed RPC task.
        crash.notify_one();
        wait_until(|| subscriptions.load(Ordering::SeqCst) == 2).await;
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        assert_eq!(rpc_active.get(), 1);
        assert_eq!(active.get(), 0);
        frames.send(frame(0)).await.expect("test operation");
        wait_until(|| active.get() == 1).await;
        count.store(2, Ordering::SeqCst);
        frames.send(frame(1)).await.expect("test operation");
        wait_until(|| {
            writer
                .db
                .retrieve_merkle_tree_insertion_by_leaf_index(&1)
                .expect("test operation")
                .is_some()
        })
        .await;
        frames
            .send(Message::Close(None))
            .await
            .expect("test operation");
        wait_until(|| subscriptions.load(Ordering::SeqCst) == 3).await;
        assert_eq!(active.get(), 0);
        assert_eq!(rpc_active.get(), 1);
        assert_eq!(starts.load(Ordering::SeqCst), 3);
        // Missing outage leaves come from RPC, not server replay.
        write_rpc(&writer, 2..=3).await;
        count.store(4, Ordering::SeqCst);
        frames.send(frame(3)).await.expect("test operation");
        wait_until(|| active.get() == 1).await;
        // A gap after takeover returns to RPC instead of skipping the leaf.
        frames.send(frame(5)).await.expect("test operation");
        wait_until(|| subscriptions.load(Ordering::SeqCst) == 4).await;
        assert_eq!(active.get(), 0);
        assert_eq!(rpc_active.get(), 1);
        assert!(writer
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&5)
            .expect("test operation")
            .is_none());
        // An idle-but-connected stream must still recover when the chain advances.
        frames.send(frame(3)).await.expect("reconnected overlap");
        wait_until(|| active.get() == 1).await;
        count.store(5, Ordering::SeqCst);
        sleep(Duration::from_millis(30)).await;
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::time::resume();
        wait_until(|| subscriptions.load(Ordering::SeqCst) == 5).await;
        assert_eq!(active.get(), 0);
        assert_eq!(rpc_active.get(), 1);
        task.abort();
        server.abort();
    }
    #[test]
    fn websocket_debug_omits_endpoint_credentials() {
        let (mut sync, _directory) = test_sync();
        sync.url =
            Url::parse("wss://user:private-password@localhost/private-path?key=private-query")
                .expect("test operation")
                .into();
        let output = format!("{sync:?}");
        assert!(!output.contains("private-"));
        assert!(output.contains("merkle_tree_hook"));
        assert!(output.contains("domain: 1"));
    }

    #[tokio::test]
    async fn rpc_fallback_preserves_durable_backward_cursor_progress() {
        let (sync, _temp_dir) = test_sync();
        let store = MerkleTreeStore::new(sync.db.clone(), Some(sync.checkpoint_wake.clone()));
        let progress = BackwardCursorProgress {
            sequence: 10,
            block: 100,
        };
        store
            .store_backward_cursor(progress)
            .await
            .expect("store progress");
        assert_eq!(
            HyperlaneBackwardCursorStore::<MerkleTreeInsertion>::retrieve_backward_cursors(
                &sync.db
            )
            .await
            .expect("read durable progress"),
            vec![progress],
        );

        let reset = BackwardCursorProgress {
            block: 200,
            ..progress
        };
        store
            .reset_backward_cursor(reset)
            .await
            .expect("reset progress");
        let reopened = MerkleTreeStore::new(sync.db.clone(), Some(sync.checkpoint_wake.clone()));
        assert_eq!(
            reopened
                .retrieve_backward_cursors()
                .await
                .expect("read reset progress"),
            vec![reset]
        );
        reopened
            .delete_backward_cursor(progress.sequence)
            .await
            .expect("delete progress");
        assert!(store
            .retrieve_backward_cursors()
            .await
            .expect("read deleted progress")
            .is_empty());
    }

    #[tokio::test]
    async fn rpc_store_wakes_only_for_new_leaves() {
        let (sync, _temp_dir) = test_sync();
        assert_eq!(
            contiguous_sequence(&sync.db, 0).expect("initialize sequence"),
            0
        );
        let store = MerkleTreeStore::new(sync.db.clone(), Some(sync.checkpoint_wake.clone()));
        let leaves: Vec<_> = (0_u32..600)
            .map(|sequence| {
                (
                    Indexed::from(MerkleTreeInsertion::new(
                        sequence,
                        H256::from_low_u64_be(u64::from(sequence)),
                    )),
                    LogMeta {
                        block_number: u64::from(sequence),
                        ..Default::default()
                    },
                )
            })
            .collect();

        assert_eq!(
            store
                .store_logs(&leaves)
                .await
                .expect("store fallback leaves"),
            600
        );
        assert!(sync.checkpoint_wake.notified().now_or_never().is_some());
        assert_eq!(
            store.store_logs(&leaves).await.expect("duplicate leaves"),
            0
        );
        assert!(sync.checkpoint_wake.notified().now_or_never().is_none());
        assert_eq!(
            contiguous_sequence(&sync.db, 0).expect("read contiguous RPC prefix"),
            600
        );
    }

    #[test]
    fn concurrent_rpc_repair_wins_over_unverified_stream_insert() {
        let (sync, _temp_dir) = test_sync();
        let candidate = MerkleTreeInsertion::new(0, H256::from_low_u64_be(4));
        let canonical = MerkleTreeInsertion::new(0, H256::from_low_u64_be(5));
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                barrier.wait();
                sync.db
                    .store_tree_insertion_if_absent(&candidate, 12)
                    .expect("store stream candidate");
            });
            scope.spawn(|| {
                barrier.wait();
                sync.db
                    .store_tree_insertion(&canonical, 13)
                    .expect("store RPC repair");
            });
        });
        assert_eq!(
            sync.db
                .retrieve_merkle_tree_insertion_by_leaf_index(&0)
                .expect("retrieve leaf"),
            Some(canonical)
        );
        assert_eq!(
            sync.db
                .retrieve_merkle_tree_insertion_block_number_by_leaf_index(&0)
                .expect("retrieve block"),
            Some(13)
        );
    }
}
