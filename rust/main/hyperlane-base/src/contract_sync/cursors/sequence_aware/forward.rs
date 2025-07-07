//! A sequence-aware cursor that syncs forwards in perpetuity, reacting to gaps in log sequences
//! and only indexing ranges of logs that are likely to contain new logs.

use std::{
    cmp::Ordering, collections::HashSet, fmt::Debug, ops::RangeInclusive, sync::Arc, time::Duration,
};

use async_trait::async_trait;
use eyre::Result;
use itertools::Itertools;
use maplit::hashmap;
use tracing::{debug, instrument, warn};

use hyperlane_core::{
    indexed_to_sequence_indexed_array, ContractSyncCursor, CursorAction, HyperlaneDomain,
    HyperlaneSequenceAwareIndexerStoreReader, IndexMode, Indexed, LogMeta, SequenceAwareIndexer,
    SequenceIndexed,
};

use crate::cursors::Indexable;

use super::{CursorMetrics, LastIndexedSnapshot, MetricsData, TargetSnapshot};

/// A sequence-aware cursor that syncs forwards in perpetuity.
pub(crate) struct ForwardSequenceAwareSyncCursor<T> {
    /// The max chunk size to query for logs.
    /// If in sequence mode, this is the max number of sequences to query.
    /// If in block mode, this is the max number of blocks to query.
    chunk_size: u32,
    /// The latest sequence count querier.
    /// This is used to check if there are new logs to index and to
    /// establish targets to index towards.
    latest_sequence_querier: Arc<dyn SequenceAwareIndexer<T>>,
    /// A store used to check which logs have already been indexed.
    store: Arc<dyn HyperlaneSequenceAwareIndexerStoreReader<T>>,
    /// A snapshot of the last indexed log, or if no indexing has occurred yet,
    /// the initial log to start indexing forward from.
    last_indexed_snapshot: LastIndexedSnapshot,
    /// The current snapshot we're indexing. As this is a forward cursor,
    /// if the last indexed snapshot was sequence 100, this would be sequence 101.
    current_indexing_snapshot: TargetSnapshot,
    /// The target snapshot to index towards.
    target_snapshot: Option<TargetSnapshot>,
    /// The mode of indexing.
    index_mode: IndexMode,
    /// The domain the cursor is indexing.
    domain: HyperlaneDomain,
    /// Cursor metrics.
    metrics: Arc<CursorMetrics>,
}

impl<T> Debug for ForwardSequenceAwareSyncCursor<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForwardSequenceAwareSyncCursor")
            .field("chunk_size", &self.chunk_size)
            .field("last_indexed_snapshot", &self.last_indexed_snapshot)
            .field("current_indexing_snapshot", &self.current_indexing_snapshot)
            .field("target_snapshot", &self.target_snapshot)
            .field("index_mode", &self.index_mode)
            .field("domain", &self.domain)
            .finish()
    }
}

impl<T: Debug + Clone + Sync + Send + Indexable + 'static> ForwardSequenceAwareSyncCursor<T> {
    #[instrument(
        skip(store, latest_sequence_querier, metrics_data),
        fields(chunk_size, next_sequence, start_block, index_mode),
        ret
    )]
    pub fn new(
        chunk_size: u32,
        latest_sequence_querier: Arc<dyn SequenceAwareIndexer<T>>,
        store: Arc<dyn HyperlaneSequenceAwareIndexerStoreReader<T>>,
        next_sequence: u32,
        start_block: u32,
        index_mode: IndexMode,
        metrics_data: MetricsData,
    ) -> Self {
        // If the next sequence is 0, we're starting from the beginning and haven't
        // indexed anything yet.
        let last_indexed_snapshot = LastIndexedSnapshot {
            sequence: (next_sequence > 0).then(|| next_sequence.saturating_sub(1)),
            at_block: start_block,
        };
        let MetricsData { domain, metrics } = metrics_data;

        Self {
            chunk_size,
            latest_sequence_querier,
            store,
            last_indexed_snapshot,
            current_indexing_snapshot: TargetSnapshot {
                sequence: next_sequence,
                at_block: start_block,
            },
            target_snapshot: None,
            index_mode,
            domain,
            metrics,
        }
    }

    /// Get the last indexed sequence or 0 if no logs have been indexed yet.
    pub fn last_sequence(&self) -> u32 {
        self.last_indexed_snapshot.sequence.unwrap_or(0)
    }

    /// Gets the next range of logs to index.
    /// If there are no logs to index, returns `None`.
    /// If there are logs to index, returns the range of logs, either by sequence or block number
    /// depending on the mode.
    pub async fn get_next_range(&mut self) -> Result<Option<RangeInclusive<u32>>> {
        // Skip any already indexed logs.
        self.skip_indexed().await?;

        let (Some(onchain_sequence_count), tip) = self
            .latest_sequence_querier
            .latest_sequence_count_and_tip()
            .await?
        else {
            return Ok(None);
        };

        // for updating metrics even if there's no indexable events available
        let max_sequence = onchain_sequence_count.saturating_sub(1) as i64;
        self.update_metrics(max_sequence);

        let current_sequence = self.current_indexing_snapshot.sequence;
        let range = match current_sequence.cmp(&onchain_sequence_count) {
            Ordering::Equal => {
                // We are synced up to the latest sequence so we don't need to index anything.

                // We can update the current indexing snapshot to the tip.
                // This will let us only index blocks that are likely to have new logs once
                // there's a new sequence to search for.
                self.current_indexing_snapshot.at_block = tip;

                None
            }
            Ordering::Less => {
                // The cursor is behind the onchain sequence count, so we need to index.

                // Minus one because this is the sequence we're targeting, not the count.
                let target_sequence = onchain_sequence_count.saturating_sub(1);

                // Set the target to the highest sequence and tip.
                // We don't necessarily expect to hit this target in the next query (because we
                // have limits to the range size based off the chunk size), but we will use it
                // as an eventual target.
                self.target_snapshot = Some(TargetSnapshot {
                    sequence: target_sequence,
                    at_block: tip,
                });

                match &self.index_mode {
                    IndexMode::Block => self.get_next_block_range(tip),
                    IndexMode::Sequence => {
                        Some(self.get_next_sequence_range(current_sequence, target_sequence))
                    }
                }
            }
            Ordering::Greater => {
                // Providers may be internally inconsistent, e.g. RPC request A could hit a node
                // whose tip is N and subsequent RPC request B could hit a node whose tip is < N.
                // Just warn and try to continue as normal.
                warn!(
                    current_sequence,
                    onchain_sequence_count,
                    "Current sequence is greater than the onchain sequence count"
                );
                None
            }
        };

        Ok(range)
    }

    /// Gets the next block range to index.
    /// Only used in block mode.
    fn get_next_block_range(&self, tip: u32) -> Option<RangeInclusive<u32>> {
        // This should never happen, but if it does, we log a warning and return None.
        if self.current_indexing_snapshot.at_block > tip {
            warn!(
                current_indexing_snapshot=?self.current_indexing_snapshot,
                last_indexed_snapshot=?self.last_indexed_snapshot,
                target_snapshot=?self.target_snapshot,
                tip,
                "Current indexing snapshot's block number is greater than the tip"
            );
            return None;
        }

        // Query the block range starting from the current_indexing_snapshot's at_block.
        Some(
            self.current_indexing_snapshot.at_block
                ..=u32::min(
                    self.current_indexing_snapshot.at_block + self.chunk_size,
                    tip,
                ),
        )
    }

    /// Gets the next sequence range to index.
    /// Only used in sequence mode.
    fn get_next_sequence_range(
        &self,
        current_sequence: u32,
        target_sequence: u32,
    ) -> RangeInclusive<u32> {
        // Query the sequence range starting from the cursor count.
        current_sequence..=u32::min(target_sequence, current_sequence + self.chunk_size)
    }

    /// Reads the DB to check if the current indexing sequence has already been indexed,
    /// iterating until we find a sequence that hasn't been indexed.
    async fn skip_indexed(&mut self) -> Result<()> {
        let prev_indexed_snapshot = self.last_indexed_snapshot.clone();
        // Check if any new logs have been inserted into the DB,
        // and update the cursor accordingly.
        while let Some(block_number) = self
            .get_sequence_log_block_number(self.current_indexing_snapshot.sequence)
            .await?
        {
            self.last_indexed_snapshot = LastIndexedSnapshot {
                sequence: Some(self.current_indexing_snapshot.sequence),
                at_block: block_number,
            };

            self.current_indexing_snapshot = self.last_indexed_snapshot.next_target();
        }
        debug!(
            last_indexed_snapshot=?prev_indexed_snapshot,
            current_indexing_snapshot=?self.current_indexing_snapshot,
            "Fast forwarded current sequence to"
        );

        Ok(())
    }

    /// Gets the log block number of a previously indexed sequence. Returns None if the
    /// log for the sequence number hasn't been indexed.
    async fn get_sequence_log_block_number(&self, sequence: u32) -> Result<Option<u32>> {
        // Ensure there's a full entry for the sequence.
        if self.store.retrieve_by_sequence(sequence).await?.is_some() {
            // And get the block number.
            if let Some(block_number) = self
                .store
                .retrieve_log_block_number_by_sequence(sequence)
                .await?
            {
                return Ok(Some(block_number.try_into()?));
            }
        }

        Ok(None)
    }

    /// Updates the cursor with the logs that were found in the range.
    /// Only used in block mode.
    /// Logs are expected to be sorted by sequence in ascending order and deduplicated.
    ///
    /// Behavior:
    /// - Empty logs are allowed, but no gaps are allowed. The logs must build upon the last indexed snapshot.
    /// - If there are any gaps, the cursor rewinds to the last indexed snapshot, and ranges will be retried.
    /// - If the target block is reached and the target sequence hasn't been reached, the cursor rewinds to the last indexed snapshot.
    fn update_block_range(
        &mut self,
        logs: Vec<(SequenceIndexed<T>, LogMeta)>,
        all_log_sequences: &HashSet<u32>,
        range: RangeInclusive<u32>,
    ) -> Result<()> {
        // We require no sequence gaps and to build upon the last snapshot.
        // A non-inclusive range is used to allow updates without any logs.
        let expected_sequences = (self.current_indexing_snapshot.sequence
            ..(self.current_indexing_snapshot.sequence + logs.len() as u32))
            .collect::<HashSet<_>>();
        if all_log_sequences != &expected_sequences {
            // If there are any missing sequences, rewind to just after the last snapshot.
            self.rewind_due_to_sequence_gaps(&logs, all_log_sequences, &expected_sequences, &range);
            return Ok(());
        }

        // Update the current indexing snapshot forward.
        self.current_indexing_snapshot = TargetSnapshot {
            sequence: self.current_indexing_snapshot.sequence + logs.len() as u32,
            at_block: *range.end(),
        };

        // This means we indexed at least one log that builds on the last snapshot.
        if let Some(highest_sequence_log) = logs.last() {
            // Update the last indexed snapshot.
            self.last_indexed_snapshot = LastIndexedSnapshot {
                sequence: Some(highest_sequence_log.0.sequence),
                at_block: highest_sequence_log.1.block_number.try_into()?,
            };
        }

        let Some(target_snapshot) = self.target_snapshot.as_ref() else {
            warn!(
                ?logs,
                current_indexing_snapshot=?self.current_indexing_snapshot,
                last_indexed_snapshot=?self.last_indexed_snapshot,
                target_snapshot=?self.target_snapshot,
                "No target snapshot, cursor should not updated unless one is set",
            );
            return Ok(());
        };

        // If the end block is >= the target block and we haven't yet reached the target sequence,
        // rewind to just after the last indexed snapshot.
        if self
            .last_indexed_snapshot
            .sequence
            .map(|last_indexed_sequence| last_indexed_sequence < target_snapshot.sequence)
            .unwrap_or(true)
            && *range.end() >= target_snapshot.at_block
        {
            warn!(
                ?logs,
                current_indexing_snapshot=?self.current_indexing_snapshot,
                last_indexed_snapshot=?self.last_indexed_snapshot,
                target_snapshot=?self.target_snapshot,
                "Reached the target block number but not the target sequence, rewinding to last snapshot",
            );
            self.rewind();
            return Ok(());
        }

        Ok(())
    }

    /// Updates the cursor with the logs that were found in the range.
    /// Only used in sequence mode.
    /// Logs are expected to be sorted by sequence in ascending order and deduplicated.
    ///
    /// Behavior:
    /// - The sequences of the logs must exactly match the range.
    /// - If there are any gaps, the cursor rewinds and the range will be retried.
    fn update_sequence_range(
        &mut self,
        logs: Vec<(SequenceIndexed<T>, LogMeta)>,
        all_log_sequences: &HashSet<u32>,
        range: RangeInclusive<u32>,
    ) -> Result<()> {
        // We require that the range starts at the current sequence.
        // This should always be the case, but to be extra safe we handle this case.
        if *range.start() != self.current_indexing_snapshot.sequence {
            warn!(
                ?logs,
                ?range,
                current_indexing_snapshot=?self.current_indexing_snapshot,
                last_indexed_snapshot=?self.last_indexed_snapshot,
                target_snapshot=?self.target_snapshot,
                "Expected range to start at the current sequence",
            );
            self.rewind();
            return Ok(());
        }

        // We require that we've gotten all sequences in the range.
        let expected_sequences = range.clone().collect::<HashSet<_>>();
        if all_log_sequences != &expected_sequences {
            // If there are any missing sequences, rewind to just after the last snapshot.
            self.rewind_due_to_sequence_gaps(&logs, all_log_sequences, &expected_sequences, &range);
            return Ok(());
        }

        // If we've gotten here, it means we indexed the entire range.
        // We update the last snapshot accordingly and set ourselves up for the next sequence.
        let Some(highest_sequence_log) = logs.last() else {
            // Sequence range indexing should never have empty ranges,
            // but to be safe we handle this anyways.
            warn!(
                ?logs,
                ?range,
                current_indexing_snapshot=?self.current_indexing_snapshot,
                last_indexed_snapshot=?self.last_indexed_snapshot,
                target_snapshot=?self.target_snapshot,
                "Expected non-empty logs and range in sequence mode",
            );
            return Ok(());
        };

        // Update the last indexed snapshot.
        self.last_indexed_snapshot = LastIndexedSnapshot {
            sequence: Some(highest_sequence_log.0.sequence),
            at_block: highest_sequence_log.1.block_number.try_into()?,
        };
        // Position the current snapshot to the next sequence.
        self.current_indexing_snapshot = self.last_indexed_snapshot.next_target();

        Ok(())
    }

    /// Rewinds the cursor to target immediately after the last indexed snapshot,
    /// and logs the inconsistencies due to sequence gaps.
    fn rewind_due_to_sequence_gaps(
        &mut self,
        logs: &Vec<(SequenceIndexed<T>, LogMeta)>,
        all_log_sequences: &HashSet<u32>,
        expected_sequences: &HashSet<u32>,
        expected_sequence_range: &RangeInclusive<u32>,
    ) {
        warn!(
            all_log_sequences=?all_log_sequences.iter().sorted().collect::<Vec<_>>(),
            expected_sequences=?expected_sequences.iter().sorted().collect::<Vec<_>>(),
            ?expected_sequence_range,
            missing_expected_sequences=?expected_sequences.difference(all_log_sequences).sorted().collect::<Vec<_>>(),
            unexpected_sequences=?all_log_sequences.difference(expected_sequences).sorted().collect::<Vec<_>>(),
            ?logs,
            current_indexing_snapshot=?self.current_indexing_snapshot,
            last_indexed_snapshot=?self.last_indexed_snapshot,
            target_snapshot=?self.target_snapshot,
            "Log sequences don't exactly match the expected sequence range, rewinding to last indexed snapshot",
        );
        // If there are any missing sequences, rewind to index immediately after the last snapshot.
        self.rewind();
    }

    // Rewinds the cursor to target immediately after the last indexed snapshot.
    fn rewind(&mut self) {
        self.current_indexing_snapshot = self.last_indexed_snapshot.next_target();
    }

    // Updates the cursor metrics.
    fn update_metrics(&self, max_sequence: i64) {
        let mut labels = hashmap! {
            "event_type" => T::name(),
            "chain" => self.domain.name(),
            "cursor_type" => "forward_sequenced",
        };

        let latest_block = self.latest_queried_block();
        self.metrics
            .cursor_current_block
            .with(&labels)
            .set(latest_block as i64);

        let sequence = self.last_sequence();
        self.metrics
            .cursor_current_sequence
            .with(&labels)
            .set(sequence as i64);

        labels.remove("cursor_type");
        self.metrics
            .cursor_max_sequence
            .with(&labels)
            .set(max_sequence);
    }
}

#[async_trait]
impl<T: Send + Sync + Clone + Debug + Indexable + 'static> ContractSyncCursor<T>
    for ForwardSequenceAwareSyncCursor<T>
{
    async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
        // TODO: Fix ETA calculation
        let eta = Duration::from_secs(0);
        if let Some(range) = self.get_next_range().await? {
            Ok((CursorAction::Query(range), eta))
        } else {
            // TODO: Define the sleep time from interval flag
            Ok((CursorAction::Sleep(Duration::from_secs(5)), eta))
        }
    }

    // TODO: revisit to establish a better heuristic for cursor / indexing health
    fn latest_queried_block(&self) -> u32 {
        self.current_indexing_snapshot.at_block
    }

    /// Updates the cursor with the logs that were found in the range.
    ///
    /// Inconsistencies in the logs are not considered errors, instead they're handled by rewinding the cursor
    /// to retry ranges.
    ///
    /// ## logs
    /// The logs to ingest. If any logs are duplicated or their sequence is lower than the current indexing snapshot,
    /// they are filtered out. See `update_sequence_range` and `update_block_range` for more details based
    /// off the indexing mode.
    ///
    /// Note:
    /// - Even if the logs include a gap, in practice these logs will have already been inserted into the DB.
    ///   This means that while gaps result in a rewind here, already known logs may be "fast forwarded" through,
    ///   and the cursor won't actually end up re-indexing already known logs.
    #[instrument(err, ret, skip(logs), fields(range=?range, logs=?logs.iter().map(|(log, _)| log.sequence).collect::<Vec<_>>()))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn update(
        &mut self,
        logs: Vec<(Indexed<T>, LogMeta)>,
        range: RangeInclusive<u32>,
    ) -> Result<()> {
        // Remove any sequence duplicates, filter out any logs preceding our current snapshot,
        // and sort in ascending order.
        let logs = indexed_to_sequence_indexed_array(logs)?
            .into_iter()
            .unique_by(|(log, _)| log.sequence)
            .filter(|(log, _)| log.sequence >= self.current_indexing_snapshot.sequence)
            .sorted_by(|(log_a, _), (log_b, _)| log_a.sequence.cmp(&log_b.sequence))
            .collect::<Vec<_>>();

        let all_log_sequences = logs
            .iter()
            .map(|(log, _)| log.sequence)
            .collect::<HashSet<_>>();

        match &self.index_mode {
            IndexMode::Block => self.update_block_range(logs, &all_log_sequences, range)?,
            IndexMode::Sequence => self.update_sequence_range(logs, &all_log_sequences, range)?,
        };
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod test {
    use derive_new::new;
    use hyperlane_core::{
        ChainResult, HyperlaneDomainProtocol, HyperlaneLogStore, Indexed, Indexer, Sequenced,
    };

    use crate::cursors::CursorType;

    use super::*;

    #[derive(Debug, Clone)]
    pub struct MockLatestSequenceQuerier {
        pub latest_sequence_count: Option<u32>,
        pub tip: u32,
    }

    #[async_trait]
    impl<T> SequenceAwareIndexer<T> for MockLatestSequenceQuerier
    where
        T: Sequenced + Debug + Clone + Send + Sync + Indexable + 'static,
    {
        async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
            Ok((self.latest_sequence_count, self.tip))
        }
    }

    #[async_trait]
    impl<T> Indexer<T> for MockLatestSequenceQuerier
    where
        T: Sequenced + Debug + Clone + Send + Sync + Indexable + 'static,
    {
        async fn fetch_logs_in_range(
            &self,
            _range: RangeInclusive<u32>,
        ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
            Ok(vec![])
        }

        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            Ok(self.tip)
        }
    }

    #[derive(Debug, Clone)]
    pub struct MockHyperlaneSequenceAwareIndexerStore<T> {
        pub logs: Vec<(T, LogMeta)>,
    }

    #[async_trait]
    impl<T: Sequenced + Debug + Clone + Send + Sync + Indexable + 'static> HyperlaneLogStore<T>
        for MockHyperlaneSequenceAwareIndexerStore<T>
    {
        async fn store_logs(&self, logs: &[(Indexed<T>, LogMeta)]) -> eyre::Result<u32> {
            Ok(logs.len() as u32)
        }
    }

    #[async_trait]
    impl<T: Sequenced + Debug + Clone + Send + Sync + Indexable + 'static>
        HyperlaneSequenceAwareIndexerStoreReader<T> for MockHyperlaneSequenceAwareIndexerStore<T>
    {
        async fn retrieve_by_sequence(&self, sequence: u32) -> eyre::Result<Option<T>> {
            Ok(self
                .logs
                .iter()
                .find(|(log, _)| log.sequence() == Some(sequence))
                .map(|(log, _)| log.clone()))
        }

        async fn retrieve_log_block_number_by_sequence(
            &self,
            sequence: u32,
        ) -> eyre::Result<Option<u64>> {
            Ok(self
                .logs
                .iter()
                .find(|(log, _)| log.sequence() == Some(sequence))
                .map(|(_, meta)| meta.block_number))
        }
    }

    #[derive(Debug, Clone, new)]
    pub struct MockSequencedData {
        pub sequence: u32,
    }

    unsafe impl Sync for MockSequencedData {}
    unsafe impl Send for MockSequencedData {}

    impl From<MockSequencedData> for Indexed<MockSequencedData> {
        fn from(val: MockSequencedData) -> Self {
            let sequence = val.sequence;
            Indexed::new(val).with_sequence(sequence)
        }
    }

    impl Indexable for MockSequencedData {
        fn indexing_cursor(_domain: HyperlaneDomainProtocol) -> CursorType {
            CursorType::SequenceAware
        }

        fn name() -> &'static str {
            "mock_indexable"
        }
    }

    impl Sequenced for MockSequencedData {
        fn sequence(&self) -> Option<u32> {
            Some(self.sequence)
        }
    }

    pub fn mock_cursor_metrics() -> CursorMetrics {
        CursorMetrics {
            cursor_current_block: prometheus::IntGaugeVec::new(
                prometheus::Opts::new("cursor_current_block", "Current block of the cursor")
                    .namespace("mock")
                    .subsystem("cursor"),
                &["event_type", "chain", "cursor_type"],
            )
            .unwrap(),
            cursor_current_sequence: prometheus::IntGaugeVec::new(
                prometheus::Opts::new("cursor_current_sequence", "Current sequence of the cursor")
                    .namespace("mock")
                    .subsystem("cursor"),
                &["event_type", "chain", "cursor_type"],
            )
            .unwrap(),
            cursor_max_sequence: prometheus::IntGaugeVec::new(
                prometheus::Opts::new("cursor_max_sequence", "Max sequence of the cursor")
                    .namespace("mock")
                    .subsystem("cursor"),
                &["event_type", "chain"],
            )
            .unwrap(),
        }
    }

    pub fn log_meta_with_block(block_number: u64) -> LogMeta {
        LogMeta {
            address: Default::default(),
            block_number,
            block_hash: Default::default(),
            transaction_id: Default::default(),
            transaction_index: 0,
            log_index: Default::default(),
        }
    }

    const INITIAL_CURRENT_INDEXING_SNAPSHOT: TargetSnapshot = TargetSnapshot {
        sequence: 5,
        at_block: 90,
    };
    const INITIAL_LAST_INDEXED_SNAPSHOT: LastIndexedSnapshot = LastIndexedSnapshot {
        sequence: Some(INITIAL_CURRENT_INDEXING_SNAPSHOT.sequence - 1),
        at_block: INITIAL_CURRENT_INDEXING_SNAPSHOT.at_block,
    };

    /// Gets a cursor starting at INITIAL_CURRENT_INDEXING_SNAPSHOT.
    async fn get_test_forward_sequence_aware_sync_cursor(
        mode: IndexMode,
        chunk_size: u32,
    ) -> ForwardSequenceAwareSyncCursor<MockSequencedData> {
        let latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
            latest_sequence_count: Some(5),
            tip: 100,
        });

        let db = Arc::new(MockHyperlaneSequenceAwareIndexerStore {
            logs: vec![
                (MockSequencedData::new(0), log_meta_with_block(50)),
                (MockSequencedData::new(1), log_meta_with_block(60)),
                (MockSequencedData::new(2), log_meta_with_block(70)),
                (MockSequencedData::new(3), log_meta_with_block(80)),
                (
                    MockSequencedData::new(INITIAL_LAST_INDEXED_SNAPSHOT.sequence.unwrap()),
                    log_meta_with_block(INITIAL_LAST_INDEXED_SNAPSHOT.at_block.into()),
                ),
            ],
        });

        let metrics_data = MetricsData {
            domain: HyperlaneDomain::new_test_domain("test"),
            metrics: Arc::new(mock_cursor_metrics()),
        };
        let mut cursor = ForwardSequenceAwareSyncCursor::new(
            chunk_size,
            latest_sequence_querier,
            db,
            // Start at sequence 3 and block 70 to illustrate fast forwarding
            3,
            70,
            mode,
            metrics_data,
        );

        // Skip any already indexed logs and sanity check we start at the correct spot.
        cursor.skip_indexed().await.unwrap();
        assert_eq!(
            cursor.current_indexing_snapshot,
            INITIAL_CURRENT_INDEXING_SNAPSHOT,
        );
        assert_eq!(cursor.last_indexed_snapshot, INITIAL_LAST_INDEXED_SNAPSHOT);

        cursor
    }

    mod block_range {
        use super::*;

        const INDEX_MODE: IndexMode = IndexMode::Block;
        const CHUNK_SIZE: u32 = 100;

        async fn get_cursor() -> ForwardSequenceAwareSyncCursor<MockSequencedData> {
            get_test_forward_sequence_aware_sync_cursor(INDEX_MODE, CHUNK_SIZE).await
        }

        /// Tests successful fast forwarding & indexing where all ranges return logs.
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_normal_indexing() {
            let mut cursor = get_cursor().await;

            // As the latest sequence count is 5 and the current indexing snapshot is sequence 5, we should
            // expect no range to index.
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);

            // Update the tip, expect to still not index anything.
            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(5),
                tip: 110,
            });
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);

            // Update the latest sequence count to 6, now we expect to index.
            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(6),
                tip: 120,
            });

            // Expect the range to be:
            // (last polled block where the sequence had already been indexed, tip)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 110..=120;
            assert_eq!(range, expected_range);

            // Expect the target snapshot to be set to the latest sequence and tip.
            assert_eq!(
                cursor.target_snapshot,
                Some(TargetSnapshot {
                    sequence: 5,
                    at_block: 120,
                })
            );

            // Getting the range again without updating the cursor should yield the same range.
            let range = cursor.get_next_range().await.unwrap().unwrap();
            assert_eq!(range, expected_range);

            // Update the cursor with the found log.
            cursor
                .update(
                    vec![(
                        Indexed::new(MockSequencedData::new(5)).with_sequence(5),
                        log_meta_with_block(115),
                    )],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the next sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                TargetSnapshot {
                    sequence: 6,
                    at_block: 120,
                }
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(5),
                    at_block: 115,
                }
            );

            // And now we should get no range to index.
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);
        }

        // Tests when the cursor is so behind the tip that it'll need to index multiple ranges (due to the
        // chunk size) to catch up.
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_multiple_ranges_till_target() {
            let mut cursor = get_cursor().await;

            // Pretend like the tip is 200, and a message occurred at block 195.

            // Increase the latest sequence count, and with a tip that exceeds the chunk size.
            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(6),
                tip: 200,
            });

            // Expect the range to be:
            // (start, start + chunk_size)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 90..=190;
            assert_eq!(range, expected_range);

            // Update the cursor. Update with no logs, because the log happened in block 195.
            cursor.update(vec![], expected_range).await.unwrap();

            // Expect the cursor to have moved the current indexing snapshot's block number (but not sequence),
            // and made no changes to the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                TargetSnapshot {
                    sequence: 5,
                    at_block: 190,
                }
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(4),
                    at_block: 90,
                }
            );

            // Expect the range to be:
            // (start, tip)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 190..=200;
            assert_eq!(range, expected_range);

            // Update the cursor with the found log.
            cursor
                .update(
                    vec![(
                        Indexed::new(MockSequencedData::new(5)).with_sequence(5),
                        log_meta_with_block(195),
                    )],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the current indexing snapshot to have moved to the next sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                TargetSnapshot {
                    sequence: 6,
                    at_block: 200,
                }
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(5),
                    at_block: 195,
                }
            );

            // And now we should get no range to index.
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);
        }

        /// Tests when the cursor is so behind the tip that it'll need to index multiple ranges, but by the time
        /// it gets to the target snapshot, it realizes it missed a log and needs to rewind.
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_rewinds_for_missed_target_sequence() {
            let mut cursor = get_cursor().await;

            // Pretend like the tip is 200, and a message occurred at block 195, but we somehow miss it.

            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(6),
                tip: 200,
            });

            // Expect the range to be:
            // (start, start + chunk_size)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 90..=190;
            assert_eq!(range, expected_range);

            // Update the cursor with no found logs.
            cursor.update(vec![], expected_range).await.unwrap();

            // Expect the cursor to have moved the current indexing snapshot's block number (but not sequence),
            // and made no changes to the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                TargetSnapshot {
                    sequence: 5,
                    at_block: 190,
                }
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(4),
                    at_block: 90,
                }
            );

            // Expect the range to be:
            // (start, tip)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 190..=200;
            assert_eq!(range, expected_range);

            // Update the cursor with no found logs.
            cursor.update(vec![], expected_range).await.unwrap();

            // Expect a rewind to occur back to the last indexed snapshot's block number.
            assert_eq!(
                cursor.current_indexing_snapshot,
                TargetSnapshot {
                    sequence: 5,
                    at_block: 90,
                }
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(4),
                    at_block: 90,
                }
            );
        }

        /// Tests when the cursor is so behind the tip that it'll need to index multiple ranges. It successfully
        /// finds a log in the second range, but missed log in the first range, showing a gap. It should rewind to the
        /// last indexed snapshot.
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_rewinds_for_sequence_gaps() {
            let mut cursor = get_cursor().await;

            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                // 3 new messages since we last indexed have come in!
                latest_sequence_count: Some(7),
                tip: 200,
            });

            async fn update_and_expect_rewind(
                cur: &mut ForwardSequenceAwareSyncCursor<MockSequencedData>,
                logs: Vec<(Indexed<MockSequencedData>, LogMeta)>,
            ) {
                // For a more rigorous test case, first do a range where no logs are found,
                // then in the next range there are issues, and we should rewind to the last indexed snapshot.

                // Expect the range to be:
                // (start, start + chunk_size)
                let range = cur.get_next_range().await.unwrap().unwrap();
                let expected_range = 90..=190;
                assert_eq!(range, expected_range);

                // Update the cursor with no found logs. We should've found one here though!
                cur.update(vec![], expected_range).await.unwrap();

                // Expect the cursor to have moved the current indexing snapshot's block number (but not sequence),
                // and made no changes to the last indexed snapshot.
                assert_eq!(
                    cur.current_indexing_snapshot,
                    TargetSnapshot {
                        sequence: 5,
                        at_block: 190,
                    }
                );
                assert_eq!(
                    cur.last_indexed_snapshot,
                    LastIndexedSnapshot {
                        sequence: Some(4),
                        at_block: 90,
                    }
                );

                // Expect the range to be:
                // (start, tip)
                let range = cur.get_next_range().await.unwrap().unwrap();
                let expected_range = 190..=200;
                assert_eq!(range, expected_range);

                // Update the cursor, expecting a rewind now
                cur.update(logs, expected_range).await.unwrap();

                // Expect a rewind to occur back to the last indexed snapshot's block number.
                assert_eq!(
                    cur.current_indexing_snapshot,
                    TargetSnapshot {
                        sequence: 5,
                        at_block: 90,
                    }
                );
                assert_eq!(
                    cur.last_indexed_snapshot,
                    LastIndexedSnapshot {
                        sequence: Some(4),
                        at_block: 90,
                    }
                );
            }

            // We don't build upon the last sequence (5 missing)
            update_and_expect_rewind(
                &mut cursor,
                vec![(MockSequencedData::new(6).into(), log_meta_with_block(100))],
            )
            .await;

            // There's a gap (sequence 6 missing)
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(5).into(), log_meta_with_block(95)),
                    (MockSequencedData::new(7).into(), log_meta_with_block(105)),
                ],
            )
            .await;
        }

        /// Tests when the cursor is so behind the tip that it'll need to index multiple ranges, but by the time
        /// it gets to the target snapshot, it realizes it missed a log and needs to rewind.
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_handles_unexpected_logs() {
            let mut cursor = get_cursor().await;

            // Pretend like the tip is 100, and a message occurred at block 95.

            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(6),
                tip: 100,
            });

            // Expect the range to be:
            // (start, start + chunk_size)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 90..=100;
            assert_eq!(range, expected_range);

            // Update the cursor with some partially bogus logs:
            // - A log at sequence 4, which was already indexed and should be ignored
            // - Three logs of sequence 5, i.e. duplicated
            // - A log at sequence 6, which is unexpected, but tolerated nonetheless
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(4).into(), log_meta_with_block(90)),
                        (MockSequencedData::new(5).into(), log_meta_with_block(95)),
                        (MockSequencedData::new(5).into(), log_meta_with_block(95)),
                        (MockSequencedData::new(6).into(), log_meta_with_block(100)),
                        (MockSequencedData::new(5).into(), log_meta_with_block(95)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the next sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                TargetSnapshot {
                    sequence: 7,
                    at_block: 100,
                }
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(6),
                    at_block: 100,
                }
            );
        }
    }

    mod sequence_range {
        use super::*;

        const INDEX_MODE: IndexMode = IndexMode::Sequence;
        const CHUNK_SIZE: u32 = 10;

        async fn get_cursor() -> ForwardSequenceAwareSyncCursor<MockSequencedData> {
            get_test_forward_sequence_aware_sync_cursor(INDEX_MODE, CHUNK_SIZE).await
        }

        /// Tests successful fast forwarding & successful indexing with a correct sequence range.
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_normal_indexing() {
            let mut cursor = get_cursor().await;

            // As the latest sequence count is 5 and the current indexing snapshot is sequence 5, we should
            // expect no range to index.
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);

            // Update the tip, expect to still not index anything.
            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(5),
                tip: 110,
            });
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);

            // Update the latest sequence count to 6, now we expect to index.
            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(6),
                tip: 120,
            });

            // Expect the range to be:
            // (new sequence, new sequence)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 5..=5;
            assert_eq!(range, expected_range);

            // Expect the target snapshot to be set to the latest sequence and tip.
            assert_eq!(
                cursor.target_snapshot,
                Some(TargetSnapshot {
                    sequence: 5,
                    at_block: 120,
                })
            );

            // Getting the range again without updating the cursor should yield the same range.
            let range = cursor.get_next_range().await.unwrap().unwrap();
            assert_eq!(range, expected_range);

            // Update the cursor with the found log.
            cursor
                .update(
                    vec![(MockSequencedData::new(5).into(), log_meta_with_block(115))],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the next sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                TargetSnapshot {
                    sequence: 6,
                    at_block: 115,
                }
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(5),
                    at_block: 115,
                }
            );

            // And now we should get no range to index.
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);

            // Update the latest sequence count to 30 to test we use the chunk size.
            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(30),
                tip: 150,
            });

            // Expect the range to be:
            // (next sequence, next sequence + chunk size)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 6..=16;
            assert_eq!(range, expected_range);
        }

        /// Tests getting no logs when a sequence range is expected.
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_rewinds_if_updated_with_no_logs() {
            let mut cursor = get_cursor().await;

            // Update the latest sequence count to 6, expecting to index.
            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(6),
                tip: 120,
            });

            // Expect the range to be:
            // (new sequence, new sequence)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 5..=5;
            assert_eq!(range, expected_range);

            // Update the cursor with no found logs.
            cursor.update(vec![], expected_range).await.unwrap();

            // Expect the cursor to have rewound to the last indexed snapshot - really this is
            // the same as not updating current indexing snapshot / last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                TargetSnapshot {
                    sequence: 5,
                    at_block: 90,
                }
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(4),
                    at_block: 90,
                }
            );
        }

        /// Tests getting a gap in the expected logs
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_rewinds_for_sequence_gaps() {
            let mut cursor = get_cursor().await;

            // Update the latest sequence count to 8, expecting to index 3 messages.
            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(8),
                tip: 120,
            });

            async fn update_and_expect_rewind(
                cur: &mut ForwardSequenceAwareSyncCursor<MockSequencedData>,
                logs: Vec<(Indexed<MockSequencedData>, LogMeta)>,
            ) {
                // Expect the range to be:
                // (new sequence, new sequence)
                let range = cur.get_next_range().await.unwrap().unwrap();
                let expected_range = 5..=7;
                assert_eq!(range, expected_range);

                // Update the cursor with sequence 5 and 7, but not 6.
                cur.update(logs, expected_range.clone()).await.unwrap();

                // Expect the cursor to have rewound to the last indexed snapshot - really this is
                // the same as not updating current indexing snapshot / last indexed snapshot.
                assert_eq!(
                    cur.current_indexing_snapshot,
                    TargetSnapshot {
                        sequence: 5,
                        at_block: 90,
                    }
                );
                assert_eq!(
                    cur.last_indexed_snapshot,
                    LastIndexedSnapshot {
                        sequence: Some(4),
                        at_block: 90,
                    }
                );
            }

            // Don't build upon the last sequence (5 missing)
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(6).into(), log_meta_with_block(100)),
                    (MockSequencedData::new(7).into(), log_meta_with_block(105)),
                ],
            )
            .await;

            // There's a gap (missing sequence 6)
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(5).into(), log_meta_with_block(115)),
                    (MockSequencedData::new(7).into(), log_meta_with_block(120)),
                ],
            )
            .await;

            // Final sequence is missing
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(5).into(), log_meta_with_block(115)),
                    (MockSequencedData::new(6).into(), log_meta_with_block(120)),
                ],
            )
            .await;

            // Correct sequences but also an unexpected sequence (8)
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(5).into(), log_meta_with_block(115)),
                    (MockSequencedData::new(6).into(), log_meta_with_block(115)),
                    (MockSequencedData::new(7).into(), log_meta_with_block(120)),
                    (MockSequencedData::new(8).into(), log_meta_with_block(125)),
                ],
            )
            .await;
        }
    }
}
