use std::{collections::BTreeMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use eyre::{bail, ensure, eyre, Context, ContextCompat, Result};
use futures_util::{
    future::{BoxFuture, Shared},
    stream, FutureExt, StreamExt,
};
use prometheus::IntGauge;
use rand::Rng;
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
        StreamHealth, StreamTimeouts, RETRY_DELAY, RETRY_JITTER_MS, RPC_PROBE_TIMEOUT,
    },
    settings::IndexSettings,
    SequencedDataContractSync,
};
use hyperlane_core::{
    BackwardCursorProgress, HyperlaneBackwardCursorStore, HyperlaneLogStore, HyperlaneProvider,
    HyperlaneSequenceAwareIndexerStoreReader, IndexMode, Indexed, LogMeta, MerkleTreeInsertion,
    ReorgPeriod, SequenceAwareIndexer, SequenceCoverage, H256,
};
use hyperlane_metric::rpc_operation::{with_rpc_operation, RpcOperation};
use redact::Secret;

use crate::explorer::Explorer;

const EVENT_TYPE: &str = "merkle_tree_insertion";
const MAX_HANDOFF_INSERTIONS: usize = 4_096;
const HANDOFF_POLL_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) fn index_settings_for_snapshot(
    mut settings: IndexSettings,
    verified_count: u32,
) -> IndexSettings {
    // The authenticated snapshot covers exactly the prefix below this count.
    // A configured floor must not skip any of the remaining leaves.
    if matches!(settings.mode, IndexMode::Sequence) {
        settings.from = i64::from(verified_count);
    }
    settings
}

#[derive(Clone)]
pub(crate) enum RecoverySource {
    Rpc(Arc<SequencedDataContractSync<MerkleTreeInsertion>>),
    Explorer(Explorer),
}

/// Fetch replacement leaves for a batch that failed independent verification.
#[derive(Clone)]
pub(crate) struct MerkleTreeRecovery {
    pub(crate) source: RecoverySource,
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
    leaves: BTreeMap<u32, (MerkleTreeInsertion, u64)>,
}

impl RecoveryProgress {
    /// Only the contiguous prefix can participate in the subsequent checkpoint vote.
    fn prefix(&self, first: u32, last: u32) -> Vec<(MerkleTreeInsertion, u64)> {
        self.leaves
            .range(first..=last)
            .zip(first..=last)
            .map_while(|((&index, row), expected)| (index == expected).then_some(*row))
            .collect()
    }
}

impl MerkleTreeRecovery {
    /// The bootstrap needs the tip message ID and sometimes a short suffix to reach
    /// a later RPC vote. On block-indexed chains, search back from the voted tip.
    pub(crate) async fn frontier_page(
        &self,
        api: Option<&Explorer>,
        first: u32,
        end: u32,
        height: Option<u64>,
    ) -> Result<Vec<(MerkleTreeInsertion, u64)>> {
        let sync = match &self.source {
            RecoverySource::Explorer(api) => return api.page(first, end).await,
            RecoverySource::Rpc(sync) => sync,
        };
        if let Some(api) = api {
            match api.page(first, end).await {
                Ok(rows) => return Ok(rows),
                Err(err) => warn!(?err, first, "Reading frontier insertions from RPC"),
            }
        }
        let last = end
            .saturating_sub(1)
            .min(first.saturating_add(self.index_settings.chunk_size.saturating_sub(1)));
        let mut cursor = match self.index_settings.mode {
            IndexMode::Sequence => last,
            IndexMode::Block => match height {
                Some(block) => u32::try_from(block)?,
                None => sync
                    .latest_indexed_position(IndexMode::Block)
                    .await?
                    .context("Missing finalized RPC height")?,
            },
        };
        // Providers can cap log queries at a few blocks. When historical counts
        // are available, locate the insertion and request only its block.
        let exact_block = if matches!(self.index_settings.mode, IndexMode::Block) {
            insertion_block(sync, first, cursor).await
        } else {
            None
        };
        if let Some(block) = exact_block {
            cursor = block;
        }
        let mut leaves = BTreeMap::new();
        loop {
            let start = match self.index_settings.mode {
                IndexMode::Sequence => first,
                IndexMode::Block if exact_block.is_some() => cursor,
                IndexMode::Block => {
                    cursor.saturating_sub(self.index_settings.chunk_size.saturating_sub(1))
                }
            };
            for (row, meta) in fetch_rpc_logs(sync, start..=cursor).await? {
                let leaf = *row.inner();
                if (first..=last).contains(&leaf.index()) {
                    leaves.insert(leaf.index(), (leaf, meta.block_number));
                }
            }
            if leaves.contains_key(&first)
                || exact_block.is_some()
                || start == 0
                || matches!(self.index_settings.mode, IndexMode::Sequence)
            {
                break;
            }
            cursor = start.saturating_sub(1);
        }
        ensure!(
            leaves.contains_key(&first),
            "RPC did not return frontier insertion {first}"
        );
        Ok(leaves.into_values().collect())
    }

    pub(crate) async fn fetch_insertions(
        &self,
        first_sequence: u32,
        checkpoint: &hyperlane_core::CheckpointAtBlock,
    ) -> Result<Vec<(MerkleTreeInsertion, u64)>> {
        let leaves = self
            .fetch_insertions_with_progress(
                first_sequence,
                checkpoint,
                &mut RecoveryProgress::default(),
            )
            .await?;
        ensure!(
            leaves
                .last()
                .is_some_and(|(leaf, _)| leaf.index() == checkpoint.index),
            "Insertion recovery did not return every insertion in the unverified batch"
        );
        Ok(leaves)
    }

    pub(crate) async fn fetch_insertions_with_progress(
        &self,
        first_sequence: u32,
        checkpoint: &hyperlane_core::CheckpointAtBlock,
        progress: &mut RecoveryProgress,
    ) -> Result<Vec<(MerkleTreeInsertion, u64)>> {
        ensure!(
            first_sequence <= checkpoint.index,
            "Recovery range starts after its target"
        );
        if progress.first_sequence != Some(first_sequence) {
            *progress = RecoveryProgress {
                first_sequence: Some(first_sequence),
                ..Default::default()
            };
        }
        let sync = match &self.source {
            RecoverySource::Explorer(api) => {
                let end = checkpoint
                    .index
                    .checked_add(1)
                    .context("Invalid checkpoint index")?;
                let mut next = progress.next.unwrap_or(first_sequence);
                while next < end {
                    let page = match api.page(next, end).await {
                        Ok(page) => page,
                        Err(err) if next > first_sequence => {
                            tracing::debug!(
                                ?err,
                                next,
                                "Verifying available Explorer recovery prefix"
                            );
                            break;
                        }
                        Err(err) => return Err(err),
                    };
                    for row in page {
                        progress.leaves.insert(row.0.index(), row);
                        next = next.checked_add(1).context("Insertion count overflow")?;
                    }
                    progress.next = Some(next);
                }
                return Ok(progress.prefix(first_sequence, checkpoint.index));
            }
            RecoverySource::Rpc(sync) => sync,
        };
        let (mut start, end) = self.rpc_bounds(sync, first_sequence, checkpoint).await?;
        start = progress.next.unwrap_or(start);
        while start <= end {
            let batch_end = self.batch_end(start, end);
            // Retry only the failed range; completed ranges and recovered leaves
            // remain in memory until this captured checkpoint is verified.
            let logs = loop {
                match fetch_rpc_logs(sync, start..=batch_end).await {
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
                    if let Some((existing, _)) = progress
                        .leaves
                        .insert(index, (*insertion.inner(), meta.block_number))
                    {
                        if existing != *insertion.inner() {
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
        Ok(progress.prefix(first_sequence, checkpoint.index))
    }

    fn batch_end(&self, start: u32, end: u32) -> u32 {
        start
            .saturating_add(self.index_settings.chunk_size.saturating_sub(1))
            .min(end)
    }

    async fn rpc_bounds(
        &self,
        sync: &SequencedDataContractSync<MerkleTreeInsertion>,
        first_sequence: u32,
        checkpoint: &hyperlane_core::CheckpointAtBlock,
    ) -> Result<(u32, u32)> {
        Ok(match self.index_settings.mode {
            IndexMode::Block => {
                // Tag-based checkpoint reads may not return a height. Resolve a
                // finalized scan boundary only after entering RPC recovery. The
                // recovered leaves must still reproduce the captured checkpoint.
                let end = match checkpoint.block_height {
                    Some(height) => u32::try_from(height)?,
                    None => timeout(
                        RPC_PROBE_TIMEOUT,
                        sync.latest_indexed_position(IndexMode::Block),
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
        })
    }

    pub(crate) fn store_verified_insertions(
        &self,
        leaves: &[(MerkleTreeInsertion, u64)],
    ) -> Result<()> {
        for (insertion, height) in leaves {
            self.db.store_tree_insertion(insertion, *height)?;
        }
        Ok(())
    }
}

async fn insertion_block(
    sync: &SequencedDataContractSync<MerkleTreeInsertion>,
    index: u32,
    mut high: u32,
) -> Option<u32> {
    let mut step = 1;
    let mut low = loop {
        let before = high.saturating_sub(step);
        let count = sync
            .indexer()
            .sequence_count_at_block(before)
            .await
            .ok()??;
        if count <= index {
            break before.saturating_add(1);
        }
        if before == 0 {
            return Some(0);
        }
        high = before;
        step = step.saturating_mul(2);
    };
    while low < high {
        let mid = low.midpoint(high);
        if sync.indexer().sequence_count_at_block(mid).await.ok()?? > index {
            high = mid;
        } else {
            low = mid.saturating_add(1);
        }
    }
    Some(high)
}

async fn fetch_rpc_logs(
    sync: &SequencedDataContractSync<MerkleTreeInsertion>,
    range: std::ops::RangeInclusive<u32>,
) -> Result<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
    Ok(timeout(
        RPC_PROBE_TIMEOUT,
        with_rpc_operation(RpcOperation::ContractSync, sync.fetch_logs_in_range(range)),
    )
    .await
    .context("RPC fallback checkpoint recovery timed out")??)
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
    async fn retrieve_sequence_coverage(&self) -> Result<Option<SequenceCoverage>> {
        HyperlaneBackwardCursorStore::<MerkleTreeInsertion>::retrieve_sequence_coverage(&self.db)
            .await
    }

    async fn store_sequence_coverage(&self, coverage: SequenceCoverage) -> Result<()> {
        HyperlaneBackwardCursorStore::<MerkleTreeInsertion>::store_sequence_coverage(
            &self.db, coverage,
        )
        .await
    }

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
        first_sequence: u32,
    ) -> Self {
        let domain = sync.domain().name().to_owned();
        let handle = tokio::spawn(
            async move {
                loop {
                    match sync
                        .cursor_from_sequence(index_settings.clone(), first_sequence)
                        .await
                    {
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
    pub(crate) explorer: Option<Explorer>,
    pub(crate) allow_rpc_fallback: bool,
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
            explorer: None,
            allow_rpc_fallback: true,
            confirmations: None,
            websocket_active,
            fallback_active,
            checkpoint_wake: Arc::new(Notify::new()),
        }
    }

    pub(crate) fn checkpoint_wake(&self) -> Arc<Notify> {
        self.checkpoint_wake.clone()
    }

    /// Historical publication fills the prefix below the live verification floor.
    pub(crate) async fn fill_history(
        &self,
        recovery: MerkleTreeRecovery,
        target: hyperlane_core::CheckpointAtBlock,
    ) {
        let end = target
            .index
            .checked_add(1)
            .expect("verified frontier count");
        let mut next = 0;
        let mut block_range = None;
        while next < end {
            let result: Result<()> = async {
                next = load_contiguous_sequence(self.db.clone(), next).await?;
                if next >= end {
                    return Ok(());
                }
                if let Some(api) = &self.explorer {
                    match api.page(next, end).await {
                        Ok(page) => return self.store_page(page, &mut next),
                        Err(err) if !self.allow_rpc_fallback => return Err(err),
                        Err(err) => warn!(?err, next, "Historical insertion page unavailable"),
                    }
                }
                let RecoverySource::Rpc(sync) = &recovery.source else {
                    bail!("Missing historical insertion source");
                };
                let (start, last) = match block_range {
                    Some(bounds) => bounds,
                    None => recovery.rpc_bounds(sync, next, &target).await?,
                };
                ensure!(start <= last, "Empty historical RPC scan range");
                let batch_end = recovery.batch_end(start, last);
                warn!(
                    start,
                    batch_end, "Fetching historical insertion range from RPC"
                );
                let mut logs = fetch_rpc_logs(sync, start..=batch_end).await?;
                logs.sort_unstable_by_key(|(row, _)| row.inner().index());
                let first = next;
                // Restart a block scan if the returned leaves expose an earlier gap.
                block_range = None;
                for (row, meta) in logs {
                    if (first..end).contains(&row.inner().index()) {
                        self.store_insertion(*row.inner(), meta.block_number, &mut next)?;
                    }
                }
                match recovery.index_settings.mode {
                    IndexMode::Sequence => ensure!(next > first, "RPC did not return leaf {next}"),
                    IndexMode::Block if batch_end < last => {
                        block_range = Some((batch_end.saturating_add(1), last));
                    }
                    IndexMode::Block => {
                        ensure!(next >= end, "Historical RPC scan ended before leaf {next}")
                    }
                }
                Ok(())
            }
            .await;
            if let Err(err) = result {
                warn!(?err, next, "Historical insertion recovery failed; retrying");
                sleep(RETRY_DELAY).await;
            }
        }
    }

    /// Buffer live events while filling the prefix through Explorer or RPC.
    pub(crate) async fn run(
        mut self,
        floor: impl std::future::Future<Output = u32> + Send + 'static,
        fallback_sync: Arc<SequencedDataContractSync<MerkleTreeInsertion>>,
        index_settings: IndexSettings,
        provider: Arc<dyn HyperlaneProvider>,
        reorg_period: ReorgPeriod,
    ) {
        // Block tags retain the scraper's canonical confirmation policy.
        self.confirmations = reorg_period.as_blocks().ok();
        let retry_delay = RETRY_DELAY
            .checked_add(Duration::from_millis(
                rand::thread_rng().gen_range(0..RETRY_JITTER_MS).into(),
            ))
            .expect("bounded retry jitter cannot overflow Duration");
        self.run_loop(
            floor,
            StreamTimeouts::default(),
            retry_delay,
            StreamDependencies {
                provider,
                indexer: fallback_sync.indexer().clone(),
            },
            |floor| {
                RpcFallback::start(
                    fallback_sync.clone(),
                    index_settings_for_snapshot(index_settings.clone(), floor),
                    self.fallback_active.clone(),
                    floor,
                )
            },
        )
        .await;
    }

    async fn run_loop(
        &self,
        floor: impl std::future::Future<Output = u32> + Send + 'static,
        timeouts: StreamTimeouts,
        retry_delay: Duration,
        dependencies: StreamDependencies,
        mut start_fallback: impl FnMut(u32) -> RpcFallback,
    ) {
        let floor = floor.boxed().shared();
        let mut next_sequence = 0;
        let mut fallback = if self.explorer.is_none() && self.allow_rpc_fallback {
            Some(start_fallback(floor.clone().await))
        } else {
            None
        };
        loop {
            let result = self
                .stream_with_timeout(
                    &mut next_sequence,
                    &mut fallback,
                    timeouts,
                    &dependencies,
                    floor.clone(),
                )
                .await;
            self.websocket_active.set(0);
            if self.allow_rpc_fallback
                && fallback
                    .as_ref()
                    .is_none_or(|task| task.handle.is_finished())
            {
                if let Some(task) = fallback.take() {
                    task.stop().await;
                }
                fallback = Some(start_fallback(floor.clone().await));
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
        floor: Shared<BoxFuture<'static, u32>>,
    ) -> Result<()> {
        let mut socket = ScraperSession::<_, Result<(u32, u32)>>::connect_validator(
            self.url.expose_secret(),
            self.domain,
            self.confirmations,
            timeouts,
        )
        .await?;
        info!(
            domain = self.domain,
            "Connected to live Merkle tree insertions"
        );
        let mut pending = BTreeMap::new();
        let mut page = None;
        let mut last_page_failure = None;
        let mut received_boundary = false;
        let mut target_count = None;
        let mut live = false;
        let marker_deadline = tokio::time::sleep(timeouts.read);
        tokio::pin!(marker_deadline);
        let mut health = StreamHealth::new(timeouts.progress_grace);
        let mut handoff_poll = interval(HANDOFF_POLL_INTERVAL);
        handoff_poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            let sequence = *next_sequence;
            let event = tokio::select! {
                _ = &mut marker_deadline, if !received_boundary => {
                    bail!("Explorer live-start boundary timed out")
                }
                result = async { page.as_mut().expect("pending Explorer page").await }, if page.is_some() => {
                    page = None;
                    match result {
                        Ok(rows) => {
                            self.stop_fallback(fallback, next_sequence).await?;
                            self.store_page(rows, next_sequence)?;
                        }
                        Err(err) if pending.contains_key(next_sequence) => {
                            tracing::debug!(?err, "Buffered live stream covers missing Explorer insertion");
                        }
                        Err(err) if fallback.is_some() => {
                            tracing::debug!(?err, "RPC fallback is still filling the handoff gap");
                            last_page_failure = Some(tokio::time::Instant::now());
                        }
                        Err(err) => return Err(err),
                    }
                    None
                }
                _ = handoff_poll.tick(), if !live && fallback.is_some() => None,
                event = socket.next::<EventData>(live, || {
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
                    let (floor, target) = result?;
                    *next_sequence = (*next_sequence).max(floor);
                    target_count = Some(target);
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
                        health.observe(count, *next_sequence)?;
                    }
                    continue;
                }
            };
            if let Some(message) = message {
                match message {
                    ServerMessage::LiveStart(wire) => {
                        ensure!(!received_boundary, "Duplicate live-start boundary");
                        received_boundary = true;
                        let boundary = self.accept_boundary(wire)?;
                        let floor = floor.clone();
                        let dependencies = dependencies.clone();
                        socket.start_cutover(self.domain, async move {
                            let floor = floor.await;
                            let target = timeout(timeouts.read, async {
                                loop {
                                    if let Some(count) =
                                        boundary_probe(&dependencies, boundary).await?
                                    {
                                        return Ok::<_, eyre::Report>(count);
                                    }
                                    sleep(HANDOFF_POLL_INTERVAL).await;
                                }
                            })
                            .await
                            .context("Live-start RPC verification timed out")??;
                            Ok((floor, target))
                        });
                    }
                    ServerMessage::LiveStartUnavailable { domain } => {
                        bail!(RejectedStream(format!(
                            "Live-start boundary unavailable for domain {domain}"
                        )));
                    }
                    ServerMessage::Event(event) => {
                        let Some((insertion, block_number)) = self.decode_event(event)? else {
                            continue;
                        };
                        if !live && insertion.index() >= *next_sequence {
                            buffer_insertion(&mut pending, insertion, block_number)?;
                        } else {
                            self.store_insertion(insertion, block_number, next_sequence)?;
                        }
                    }
                    ServerMessage::Error { error } => return Err(RejectedStream(error).into()),
                    ServerMessage::Rollback { .. } => {
                        bail!("Scraper stream rolled back; reconnecting")
                    }
                    _ => {}
                }
            }
            if !live && page.is_none() {
                live = self
                    .try_handoff(next_sequence, target_count, fallback, &mut pending)
                    .await?;
                if live
                    || (fallback.is_some()
                        && last_page_failure.is_some_and(|t| t.elapsed() < RETRY_DELAY))
                {
                    continue;
                }
                if let (Some(target), Some(api)) = (target_count, &self.explorer) {
                    let end = pending
                        .range(*next_sequence..)
                        .next()
                        .map_or(target, |(index, _)| target.min(*index));
                    page = Some(Box::pin(api.page(*next_sequence, end)));
                }
            }
        }
    }

    async fn try_handoff(
        &self,
        next_sequence: &mut u32,
        target_count: Option<u32>,
        fallback: &mut Option<RpcFallback>,
        pending: &mut BTreeMap<u32, (MerkleTreeInsertion, u64)>,
    ) -> Result<bool> {
        if fallback
            .as_ref()
            .is_some_and(|task| task.handle.is_finished())
        {
            bail!("RPC fallback indexing task exited; restarting recovery");
        }
        // This count was sampled once from independent RPC at or beyond the
        // fixed boundary. A contiguous prefix also covers snapshot-restored history.
        let Some(target) = target_count else {
            return Ok(false);
        };
        *next_sequence = load_contiguous_sequence(self.db.clone(), *next_sequence).await?;
        if *next_sequence >= target
            || (self.explorer.is_some() && pending.contains_key(next_sequence))
        {
            self.stop_fallback(fallback, next_sequence).await?;
        }
        if fallback.is_some() {
            return Ok(false);
        }
        while pending
            .first_key_value()
            .is_some_and(|(index, _)| index <= next_sequence)
        {
            let (_, (insertion, height)) = pending.pop_first().expect("buffered insertion");
            self.store_insertion(insertion, height, next_sequence)?;
        }
        if *next_sequence < target {
            return Ok(false);
        }
        ensure!(pending.is_empty(), "Gap in buffered live insertions");
        self.websocket_active.set(1);
        info!(
            domain = self.domain,
            target_count = target,
            next_sequence = *next_sequence,
            "Live-start boundary verified; switched Merkle tree hook indexing to WebSocket"
        );
        Ok(true)
    }

    async fn stop_fallback(
        &self,
        fallback: &mut Option<RpcFallback>,
        next_sequence: &mut u32,
    ) -> Result<()> {
        if let Some(task) = fallback.take() {
            task.stop().await;
            // The RPC writer may have filled part of the gap while the page was in flight.
            *next_sequence = load_contiguous_sequence(self.db.clone(), *next_sequence).await?;
        }
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

    fn store_page(&self, page: Vec<(MerkleTreeInsertion, u64)>, next: &mut u32) -> Result<()> {
        for (row, height) in page {
            self.store_insertion(row, height, next)?;
        }
        Ok(())
    }

    fn store_insertion(
        &self,
        insertion: MerkleTreeInsertion,
        block_number: u64,
        next_sequence: &mut u32,
    ) -> Result<()> {
        let leaf_index = insertion.index();
        ensure!(
            leaf_index < u32::MAX,
            "Merkle tree insertion sequence exhausted"
        );
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
            "Conflicting Merkle tree insertion at leaf {leaf_index}"
        );
        if leaf_index < *next_sequence {
            return Ok(());
        }
        *next_sequence = leaf_index.saturating_add(1);
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
        bail!("Merkle handoff buffer limit exceeded");
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

    async fn listener_for(sync: &mut MerkleTreeHookWebSocketSync) -> TcpListener {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        sync.url = Url::parse(&format!(
            "ws://{}/validators",
            listener.local_addr().expect("address")
        ))
        .expect("test URL")
        .into();
        listener
    }

    async fn accept_ready(
        listener: &TcpListener,
    ) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
        let (tcp, _) = listener.accept().await.expect("connection");
        let mut socket = accept_async(tcp).await.expect("upgrade");
        socket.send(Message::Text(r#"{"type":"ready","domain":1,"eventTypes":["merkle_tree_insertion"],"historicalStreaming":false,"liveStartVersion":1}"#.into())).await.expect("ready");
        socket
    }

    fn frame(i: u32) -> Message {
        Message::Text(serde_json::json!({ "type": "event", "eventType": EVENT_TYPE, "domain": 1,
            "sequence": i.to_string(), "data": { "block_number": i.saturating_add(10), "domain": 1, "leaf_index": i,
            "merkle_tree_hook": format!("{:#x}", H256::from_low_u64_be(2)), "message_id": format!("{:#x}", leaf(i).message_id()) } }).to_string().into())
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
                Url::parse("ws://localhost/validators").expect("test operation"),
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
    async fn heartbeats_cannot_extend_validator_startup_indefinitely() {
        for ready in [false, true] {
            let (mut sync, _dir) = test_sync();
            let listener = listener_for(&mut sync).await;
            let server = tokio::spawn(async move {
                let mut socket = if ready {
                    accept_ready(&listener).await
                } else {
                    let (tcp, _) = listener.accept().await.expect("connection");
                    accept_async(tcp).await.expect("upgrade")
                };
                while socket.send(Message::Ping(vec![1].into())).await.is_ok() {
                    sleep(Duration::from_millis(20)).await;
                }
            });
            let mut fallback = Some(test_fallback(&sync.fallback_active));
            let result = timeout(
                Duration::from_secs(3),
                sync.stream_with_timeout(
                    &mut 0,
                    &mut fallback,
                    StreamTimeouts {
                        read: Duration::from_millis(400),
                        ..Default::default()
                    },
                    &StreamDependencies {
                        provider: test_provider(),
                        indexer: Arc::new(TestIndexer {
                            count: Arc::default(),
                            tip: 100,
                        }),
                    },
                    std::future::ready(0).boxed().shared(),
                ),
            )
            .await
            .expect("startup deadline");
            let expected = if ready {
                "live-start boundary timed out"
            } else {
                "ready timed out"
            };
            assert!(result
                .expect_err("missing startup message")
                .to_string()
                .contains(expected));
            assert!(fallback.is_some());
            server.abort();
        }
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
        let mut last_height = event(0);
        last_height.data.block_number = StringOrNumber::Number(u64::from(u32::MAX));
        assert_eq!(
            sync.decode_event(last_height)
                .expect("maximum cursor height"),
            Some((leaf(0), u64::from(u32::MAX)))
        );
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
        let index = u32::MAX;
        let mut exhausted = index;
        assert!(sync
            .store_insertion(leaf(index), 1, &mut exhausted)
            .is_err());
        assert!(sync
            .db
            .retrieve_merkle_tree_insertion_by_leaf_index(&index)
            .expect("read exhausted index")
            .is_none());
        assert!(sync.checkpoint_wake.notified().now_or_never().is_none());
    }

    #[tokio::test]
    async fn explorer_only_buffers_during_startup_and_retries_missing_history_without_rpc_scans() {
        reconnect_to_explorer(false).await;
    }

    #[tokio::test]
    async fn recovered_explorer_takes_over_from_stalled_rpc() {
        reconnect_to_explorer(true).await;
    }

    async fn reconnect_to_explorer(allow_rpc_fallback: bool) {
        use crate::explorer::tests::{fixture, serve_async};
        let (mut sync, _dir) = test_sync();
        let rpc_active = sync.fallback_active.clone();
        // With fallback enabled the second connection also sees an empty page before recovery.
        let first_available = if allow_rpc_fallback { 2 } else { 1 };
        let queries = Arc::new(AtomicUsize::new(0));
        let calls = queries.clone();
        let reply = Arc::new(Notify::new());
        let release = reply.clone();
        let api = serve_async(
            move |request| {
                let calls = calls.clone();
                let release = release.clone();
                let rpc_active = rpc_active.clone();
                async move {
                    let attempt = calls.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        rpc_active.get(),
                        i64::from(allow_rpc_fallback && (1..=first_available).contains(&attempt))
                    );
                    if attempt > first_available {
                        release.notified().await;
                    }
                    fixture(request, u32::from(attempt >= first_available))
                }
            },
            sync.domain,
            sync.merkle_tree_hook,
        )
        .await;
        sync.explorer = Some(api.clone());
        sync.allow_rpc_fallback = allow_rpc_fallback;
        let listener = listener_for(&mut sync).await;
        let (floor, start) = tokio::sync::oneshot::channel();
        let active = sync.websocket_active.clone();
        let db = sync.db.clone();
        let task = tokio::spawn(async move {
            sync.run_loop(
                async { start.await.expect("startup floor") },
                StreamTimeouts::default(),
                Duration::from_millis(1),
                StreamDependencies {
                    provider: test_provider(),
                    indexer: Arc::new(TestIndexer {
                        count: Arc::new(AtomicUsize::new(2)),
                        tip: 100,
                    }),
                },
                |_| {
                    assert!(allow_rpc_fallback, "RPC insertion indexing is disabled");
                    test_fallback(&sync.fallback_active)
                },
            )
            .await;
        });
        let connect = || async {
            let mut socket = accept_ready(&listener).await;
            socket
                .send(Message::Text(boundary_frame().to_string().into()))
                .await
                .expect("boundary");
            socket
        };
        let _first = connect().await;
        assert_eq!(queries.load(Ordering::SeqCst), 0);
        floor.send(0).expect("use leaf zero");
        let mut second = timeout(Duration::from_secs(5), connect())
            .await
            .expect("reconnect after missing history");
        let expected_requests = first_available + 2;
        wait_until(|| queries.load(Ordering::SeqCst) == expected_requests).await;
        second.send(frame(1)).await.expect("live insertion");
        // A pong proves the client consumed the preceding event before GraphQL returns its empty page.
        second
            .send(Message::Ping(vec![1].into()))
            .await
            .expect("ping");
        assert_eq!(
            timeout(Duration::from_secs(5), second.next())
                .await
                .expect("deadline")
                .expect("frame")
                .expect("pong"),
            Message::Pong(vec![1].into())
        );
        reply.notify_one();
        wait_until(|| {
            active.get() == 1
                && db
                    .retrieve_merkle_tree_insertion_by_leaf_index(&1)
                    .expect("db read")
                    .is_some()
        })
        .await;
        assert_eq!(queries.load(Ordering::SeqCst), expected_requests);
        assert_eq!(
            db.retrieve_merkle_tree_insertion_by_leaf_index(&0)
                .expect("db read")
                .expect("first insertion")
                .message_id(),
            H256::from_low_u64_be(1)
        );
        task.abort();
    }

    #[tokio::test]
    async fn fallback_panic_disconnect_and_sequence_gap_require_a_fresh_boundary() {
        let (mut sync, _directory) = test_sync();
        let listener = listener_for(&mut sync).await;
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
                let mut socket = accept_ready(&listener).await;
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
                std::future::ready(1),
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
                |_| {
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
                serde_json::json!({"type":"rollback","domain":1,"fromHeight":"100","toHeight":"99"}).to_string().into(),
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
