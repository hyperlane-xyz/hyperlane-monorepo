use std::{collections::BTreeMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use eyre::{bail, ensure, eyre, Context, ContextCompat, Result};
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
        parse_address, reconnect_after, EventMessage, LiveStartBoundary,
        MerkleEventData as EventData, RejectedStream, ScraperSession, ServerMessage, SessionEvent,
        StreamHealth, StreamTimeouts, SubscribeMessage, SubscribeStream, RETRY_DELAY,
        RETRY_JITTER_MS, RPC_PROBE_TIMEOUT,
    },
    settings::IndexSettings,
    ContractSyncer, SequencedDataContractSync,
};
use hyperlane_core::{
    BackwardCursorProgress, HyperlaneBackwardCursorStore, HyperlaneLogStore, HyperlaneProvider,
    HyperlaneSequenceAwareIndexerStoreReader, IndexMode, Indexed, LogMeta, MerkleTreeInsertion,
    ReorgPeriod, SequenceAwareIndexer, H256,
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
#[derive(Debug)]
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

struct StreamDependencies {
    provider: Arc<dyn HyperlaneProvider>,
    indexer: Arc<dyn SequenceAwareIndexer<MerkleTreeInsertion>>,
}

#[derive(Clone, Copy)]
struct Boundary {
    height: u64,
    hash: H256,
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
        fallback_sync: Arc<SequencedDataContractSync<MerkleTreeInsertion>>,
        index_settings: IndexSettings,
        provider: Arc<dyn HyperlaneProvider>,
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
            StreamTimeouts::default(),
            retry_delay,
            StreamDependencies {
                provider,
                indexer: fallback_sync.indexer().clone(),
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
        timeouts: StreamTimeouts,
        retry_delay: Duration,
        dependencies: StreamDependencies,
        mut start_fallback: impl FnMut() -> RpcFallback,
    ) {
        let mut fallback = Some(start_fallback());
        loop {
            let result = self
                .stream_with_timeout(&mut next_sequence, &mut fallback, timeouts, &dependencies)
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
        fallback: &mut Option<RpcFallback>,
        timeouts: StreamTimeouts,
        dependencies: &StreamDependencies,
    ) -> Result<()> {
        let mut socket =
            ScraperSession::<_, Result<Option<u32>>>::connect(self.url.expose_secret(), timeouts)
                .await?;
        let mut pending = BTreeMap::new();
        let mut boundary = None;
        let mut target_count = None;
        let mut health = StreamHealth::new(timeouts.progress_grace);
        let mut handoff_poll = interval(HANDOFF_POLL_INTERVAL);
        handoff_poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            let sequence = *next_sequence;
            let event = tokio::select! {
                _ = handoff_poll.tick(), if fallback.is_some() => {
                    if let Some(boundary) = boundary.filter(|_| target_count.is_none()) {
                        socket.start_cutover(self.domain, boundary_probe(dependencies, boundary));
                    }
                    None
                }
                event = socket.next::<EventData>(fallback.is_none(), || {
                    let probe = count_probe(dependencies);
                    stream::once(async move { (sequence, probe.await) }).boxed()
                }) => {
                    let Some(event) = event? else { return Ok(()); };
                    Some(event)
                },
            };
            let message = match event {
                Some(SessionEvent::Message(message)) => Some(message),
                Some(SessionEvent::Cutover { result, .. }) => {
                    target_count = result?;
                    None
                }
                None => None,
                Some(SessionEvent::Progress((sequence, count))) => {
                    let count = count?;
                    if *next_sequence > sequence && *next_sequence > count {
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
            if let Some(message) = message {
                match message {
                    ServerMessage::Ready { .. } => socket.subscribe(self.subscription()).await?,
                    ServerMessage::Subscribed { .. } => {
                        info!(
                            domain = self.domain,
                            "Subscribed to live Merkle tree insertions"
                        );
                    }
                    ServerMessage::LiveStart(wire) => {
                        ensure!(boundary.is_none(), "Duplicate live-start boundary");
                        let accepted = self.accept_boundary(wire)?;
                        boundary = Some(accepted);
                        socket.start_cutover(self.domain, boundary_probe(dependencies, accepted));
                    }
                    ServerMessage::LiveStartUnavailable { domain } => {
                        bail!("Live-start boundary unavailable for domain {domain}; retaining RPC indexing");
                    }
                    ServerMessage::Event(event) => {
                        let Some((insertion, block_number)) = self.decode_event(event)? else {
                            continue;
                        };
                        if fallback.is_some() && insertion.index() >= *next_sequence {
                            buffer_insertion(&mut pending, insertion, block_number)?;
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
            self.try_handoff(next_sequence, target_count, fallback, &mut pending)
                .await?;
        }
    }

    async fn try_handoff(
        &self,
        next_sequence: &mut u32,
        target_count: Option<u32>,
        fallback: &mut Option<RpcFallback>,
        pending: &mut BTreeMap<u32, (MerkleTreeInsertion, u64)>,
    ) -> Result<()> {
        let Some(task) = fallback.as_ref() else {
            return Ok(());
        };
        if task.handle.is_finished() {
            bail!("RPC fallback indexing task exited; restarting recovery");
        }
        // This count was sampled once from independent RPC at or beyond the
        // fixed boundary. A contiguous prefix also covers snapshot-restored history.
        let Some(target) = target_count else {
            return Ok(());
        };
        *next_sequence = load_contiguous_sequence(self.db.clone(), *next_sequence).await?;
        if *next_sequence < target {
            return Ok(());
        }
        // Await cancellation before admitting socket writes. RPC may have advanced
        // beyond the target while its task was stopping; deduplicate that overlap.
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
            target_count = target,
            next_sequence = *next_sequence,
            "Live-start boundary verified; switched Merkle tree hook indexing to WebSocket"
        );
        Ok(())
    }

    fn accept_boundary(&self, wire: LiveStartBoundary) -> Result<Boundary> {
        ensure!(wire.domain == self.domain, "Unexpected live-start domain");
        ensure!(
            wire.confirmations == self.confirmations,
            "Unexpected live-start confirmations"
        );
        ensure!(wire.streams.len() == 1, "Unexpected live-start streams");
        let stream = &wire.streams[0];
        ensure!(
            stream.event_type == EVENT_TYPE
                && parse_address(&stream.address)? == self.merkle_tree_hook,
            "Live-start boundary covers a different Merkle tree hook"
        );
        Ok(Boundary {
            height: wire.height.parse()?,
            hash: wire.hash.parse()?,
        })
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
        let existing = if leaf_index < *next_sequence {
            self.db
                .retrieve_merkle_tree_insertion_by_leaf_index(&leaf_index)?
        } else {
            self.db
                .store_tree_insertion_if_absent(&insertion, block_number)?
        };
        ensure!(
            existing.is_none_or(|existing| existing == insertion),
            "Conflicting WebSocket Merkle tree insertion at leaf {leaf_index}"
        );
        if leaf_index < *next_sequence {
            return Ok(());
        }
        *next_sequence = next_sequence
            .checked_add(1)
            .ok_or_else(|| eyre!("Merkle tree insertion sequence exhausted"))?;
        // Indexing never authorizes signatures; independent root verification does.
        self.checkpoint_wake.notify_one();
        Ok(())
    }
}

async fn load_contiguous_sequence(db: HyperlaneRocksDB, sequence: u32) -> Result<u32> {
    tokio::task::spawn_blocking(move || contiguous_sequence(&db, sequence))
        .await
        .context("Finding the next Merkle tree insertion sequence")?
}

fn contiguous_sequence(db: &HyperlaneRocksDB, mut sequence: u32) -> Result<u32> {
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

// Keep socket reads running during RPC checks. The result is connection scoped
// and captured once, so busy chains do not chase a moving tip during handoff.
fn boundary_probe(
    dependencies: &StreamDependencies,
    boundary: Boundary,
) -> BoxFuture<'static, Result<Option<u32>>> {
    let provider = dependencies.provider.clone();
    let indexer = dependencies.indexer.clone();
    async move {
        timeout(RPC_PROBE_TIMEOUT, async move {
            let (count, tip) = indexer.latest_sequence_count_and_tip().await?;
            if u64::from(tip) < boundary.height {
                return Ok(None);
            }
            let block = provider.get_block_by_height(boundary.height).await?;
            ensure!(
                block.number == boundary.height && block.hash == boundary.hash,
                "Live-start checkpoint does not match independent RPC"
            );
            Ok(Some(count.context(
                "Missing Merkle tree count at live-start boundary",
            )?))
        })
        .await
        .context("Live-start RPC verification timed out")?
    }
    .boxed()
}

fn count_probe(dependencies: &StreamDependencies) -> BoxFuture<'static, Result<u32>> {
    let indexer = dependencies.indexer.clone();
    async move {
        timeout(RPC_PROBE_TIMEOUT, indexer.latest_sequence_count_and_tip())
            .await
            .context("On-chain Merkle tree count probe timed out")??
            .0
            .context("Missing on-chain Merkle tree count for WebSocket freshness")
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

    #[derive(Debug)]
    struct TestIndexer {
        count: Arc<AtomicUsize>,
        tip: u32,
    }
    #[async_trait]
    impl hyperlane_core::Indexer<MerkleTreeInsertion> for TestIndexer {
        async fn fetch_logs_in_range(
            &self,
            _: std::ops::RangeInclusive<u32>,
        ) -> hyperlane_core::ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
            panic!("not a recovery scan")
        }
        async fn get_finalized_block_number(&self) -> hyperlane_core::ChainResult<u32> {
            panic!("must support sequence-only indexers")
        }
    }
    #[async_trait]
    impl SequenceAwareIndexer<MerkleTreeInsertion> for TestIndexer {
        async fn latest_sequence_count_and_tip(
            &self,
        ) -> hyperlane_core::ChainResult<(Option<u32>, u32)> {
            Ok((
                Some(u32::try_from(self.count.load(Ordering::SeqCst)).expect("test count")),
                self.tip,
            ))
        }
    }

    mockall::mock! {
        #[derive(Debug)]
        Provider {}
        impl hyperlane_core::HyperlaneChain for Provider {
            fn domain(&self) -> &HyperlaneDomain;
            fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider>;
        }
        #[async_trait]
        impl hyperlane_core::HyperlaneProvider for Provider {
            async fn get_block_by_height(&self, height: u64) -> hyperlane_core::ChainResult<hyperlane_core::BlockInfo>;
            async fn get_txn_by_hash(&self, hash: &hyperlane_core::H512) -> hyperlane_core::ChainResult<hyperlane_core::TxnInfo>;
            async fn is_contract(&self, address: &H256) -> hyperlane_core::ChainResult<bool>;
            async fn get_balance(&self, address: String) -> hyperlane_core::ChainResult<hyperlane_core::U256>;
            async fn get_chain_metrics(&self) -> hyperlane_core::ChainResult<Option<hyperlane_core::ChainInfo>>;
        }
    }

    fn test_provider() -> Arc<dyn HyperlaneProvider> {
        let mut provider = MockProvider::new();
        provider.expect_get_block_by_height().returning(|height| {
            Ok(hyperlane_core::BlockInfo {
                number: height,
                hash: H256::zero(),
                timestamp: 0,
            })
        });
        Arc::new(provider)
    }

    fn boundary_frame() -> serde_json::Value {
        serde_json::json!({ "type": "live_start", "domain": 1, "height": "10", "hash": format!("{:#x}", H256::zero()),
            "streams": [{"eventType": EVENT_TYPE, "address": format!("{:#x}", H256::from_low_u64_be(2))}] })
    }

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
    fn live_start_requires_the_requested_domain_hook_and_confirmations() {
        let (mut sync, _directory) = test_sync();
        for confirmations in [None, Some(0), Some(3)] {
            sync.confirmations = confirmations;
            let mut request = serde_json::json!({"type": "subscribe", "streams": [{"domains": [1], "eventType": EVENT_TYPE}]});
            if let Some(count) = confirmations {
                request["streams"][0]["confirmations"] = count.into();
            }
            assert_eq!(
                serde_json::to_value(sync.subscription()).expect("subscription"),
                request
            );
            let mut frame = boundary_frame();
            frame["confirmations"] = serde_json::json!(confirmations);
            let decode =
                |frame| serde_json::from_value::<LiveStartBoundary>(frame).expect("boundary");
            assert!(sync.accept_boundary(decode(frame.clone())).is_ok());
            for bad in [
                serde_json::json!({"domain": 2}),
                serde_json::json!({"confirmations": 8}),
                serde_json::json!({"height": "bad"}),
                serde_json::json!({"hash": "0x01"}),
                serde_json::json!({"streams": []}),
                serde_json::json!({"streams": [{"eventType": EVENT_TYPE, "address": format!("{:#x}", H256::zero())}]}),
            ] {
                let mut malformed = frame.clone();
                for (key, value) in bad.as_object().expect("object") {
                    malformed[key] = value.clone();
                }
                assert!(sync.accept_boundary(decode(malformed)).is_err());
            }
        }
    }

    #[tokio::test]
    async fn boundary_checks_independent_rpc_hash_and_confirmed_native_tip() {
        let dependencies = StreamDependencies {
            provider: test_provider(),
            indexer: Arc::new(TestIndexer {
                count: Arc::new(AtomicUsize::new(7)),
                tip: 100,
            }),
        };
        assert_eq!(
            boundary_probe(
                &dependencies,
                Boundary {
                    height: 100,
                    hash: H256::zero()
                }
            )
            .await
            .expect("probe"),
            Some(7)
        );
        assert_eq!(
            boundary_probe(
                &dependencies,
                Boundary {
                    height: 101,
                    hash: H256::zero()
                }
            )
            .await
            .expect("probe"),
            None
        );
        assert!(boundary_probe(
            &dependencies,
            Boundary {
                height: 100,
                hash: H256::repeat_byte(1)
            }
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn quiet_and_empty_chains_handoff_without_a_live_insertion() {
        for next in [0, 100] {
            let (sync, _directory) = test_sync();
            let mut next_sequence = next;
            let mut fallback = Some(test_fallback(&sync.fallback_active));
            let mut pending = BTreeMap::new();
            sync.try_handoff(&mut next_sequence, None, &mut fallback, &mut pending)
                .await
                .expect("no marker");
            assert!(fallback.is_some());
            sync.try_handoff(&mut next_sequence, Some(next), &mut fallback, &mut pending)
                .await
                .expect("handoff");
            assert!(fallback.is_none());
            assert_eq!(sync.websocket_active.get(), 1);
        }
    }

    #[tokio::test]
    async fn fixed_boundary_waits_for_rpc_then_drains_a_moving_live_tail() {
        let (sync, _directory) = test_sync();
        let mut next = 0;
        let mut fallback = Some(test_fallback(&sync.fallback_active));
        let mut buffer = BTreeMap::new();
        for i in 10..=20 {
            buffer_insertion(&mut buffer, leaf(i), u64::from(i).saturating_add(10))
                .expect("test operation");
        }
        sync.try_handoff(&mut next, Some(11), &mut fallback, &mut buffer)
            .await
            .expect("test operation");
        assert!(fallback.is_some());
        assert!(sync
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&10)
            .expect("test operation")
            .is_none());
        write_rpc(&sync, 0..=10).await;
        // The live head is already 20, but RPC only needs the fixed target count.
        sync.try_handoff(&mut next, Some(11), &mut fallback, &mut buffer)
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
        let mut next = contiguous_sequence(&sync.db, 10).expect("test operation");
        let mut fallback = Some(test_fallback(&sync.fallback_active));
        write_rpc(&sync, 15..=15).await;
        let mut buffer = BTreeMap::from([(15, (leaf(15), 25))]);
        sync.try_handoff(&mut next, Some(16), &mut fallback, &mut buffer)
            .await
            .expect("test operation");
        assert!(fallback.is_some());
        assert_eq!(next, 10);
        write_rpc(&sync, 10..=14).await;
        sync.try_handoff(&mut next, Some(16), &mut fallback, &mut buffer)
            .await
            .expect("test operation");
        assert!(fallback.is_none());
        assert_eq!(next, 16);
        assert_eq!(contiguous_sequence(&sync.db, 0).expect("snapshot loss"), 0);
    }

    #[tokio::test]
    async fn rpc_progress_past_the_boundary_is_deduplicated_without_overwriting() {
        let (sync, _directory) = test_sync();
        let mut next = 0;
        let mut fallback = Some(test_fallback(&sync.fallback_active));
        write_rpc(&sync, 0..=8).await;
        let mut buffer = BTreeMap::new();
        for i in 4..=10 {
            buffer_insertion(&mut buffer, leaf(i), 999).expect("test operation");
        }
        sync.try_handoff(&mut next, Some(6), &mut fallback, &mut buffer)
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
        sync.websocket_active.set(0);
        let mut fallback = Some(test_fallback(&sync.fallback_active));
        let mut conflict = BTreeMap::from([(8, (MerkleTreeInsertion::new(8, H256::zero()), 999))]);
        assert!(sync
            .try_handoff(&mut next, Some(9), &mut fallback, &mut conflict)
            .await
            .is_err());
        assert_eq!(sync.websocket_active.get(), 0);
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
    async fn fallback_panic_disconnect_and_sequence_gap_require_a_fresh_boundary() {
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
        write_rpc(&sync, 0..=0).await;
        let writer = sync.clone();
        let active = sync.websocket_active.clone();
        let rpc_active = sync.fallback_active.clone();
        let starts = Arc::new(AtomicUsize::new(0));
        let started = starts.clone();
        let count = Arc::new(AtomicUsize::new(1));
        let indexer = Arc::new(TestIndexer {
            count: count.clone(),
            tip: 100,
        });
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
                StreamTimeouts {
                    read: Duration::from_secs(3600),
                    progress_check: Duration::from_millis(10),
                    progress_grace: Duration::from_secs(5),
                },
                Duration::from_millis(1),
                StreamDependencies {
                    provider: test_provider(),
                    indexer,
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
        // No boundary is needed to detect and replace a failed RPC task.
        crash.notify_one();
        wait_until(|| subscriptions.load(Ordering::SeqCst) == 2).await;
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        assert_eq!(rpc_active.get(), 1);
        assert_eq!(active.get(), 0);
        let marker = || Message::Text(boundary_frame().to_string().into());
        frames.send(marker()).await.expect("live-start");
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
        frames.send(marker()).await.expect("new live-start");
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
        frames.send(marker()).await.expect("reconnected boundary");
        wait_until(|| active.get() == 1).await;
        frames
            .send(Message::Text(
                serde_json::json!({"type":"rollback"}).to_string().into(),
            ))
            .await
            .expect("rollback");
        wait_until(|| subscriptions.load(Ordering::SeqCst) == 5).await;
        assert_eq!(active.get(), 0);
        assert_eq!(rpc_active.get(), 1);
        frames.send(marker()).await.expect("post-rollback boundary");
        wait_until(|| active.get() == 1).await;
        count.store(5, Ordering::SeqCst);
        sleep(Duration::from_millis(30)).await;
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::time::resume();
        wait_until(|| subscriptions.load(Ordering::SeqCst) == 6).await;
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
    async fn rpc_store_wakes_only_for_new_leaves() {
        let (sync, _temp_dir) = test_sync();
        let store = MerkleTreeStore::new(sync.db.clone(), Some(sync.checkpoint_wake.clone()));
        let leaves = [(
            Indexed::from(leaf(0)),
            LogMeta {
                block_number: 10,
                ..Default::default()
            },
        )];

        assert_eq!(
            store
                .store_logs(&leaves)
                .await
                .expect("store fallback leaves"),
            1
        );
        assert!(sync.checkpoint_wake.notified().now_or_never().is_some());
        assert_eq!(
            store.store_logs(&leaves).await.expect("duplicate leaves"),
            0
        );
        assert!(sync.checkpoint_wake.notified().now_or_never().is_none());
        assert_eq!(
            contiguous_sequence(&sync.db, 0).expect("read contiguous RPC prefix"),
            1
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
