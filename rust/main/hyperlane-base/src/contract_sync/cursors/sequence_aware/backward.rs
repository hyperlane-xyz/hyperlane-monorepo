//! A sequence-aware cursor that syncs backwards until there are no earlier logs to index.

use std::{collections::HashSet, fmt::Debug, ops::RangeInclusive, sync::Arc, time::Duration};

use async_trait::async_trait;
use eyre::Result;
use itertools::Itertools;
use maplit::hashmap;
use tokio::time::sleep;
use tracing::{debug, info, instrument, warn};

use hyperlane_core::{
    indexed_to_sequence_indexed_array, ContractSyncCursor, CursorAction, HyperlaneDomain,
    HyperlaneSequenceAwareIndexerStoreReader, IndexMode, Indexed, LogMeta, SequenceAwareIndexer,
    SequenceIndexed,
};

use crate::cursors::Indexable;

use super::{CursorMetrics, LastIndexedSnapshot, MetricsData, TargetSnapshot};

const MAX_BACKWARD_SYNC_BLOCKING_TIME: Duration = Duration::from_secs(5);

/// A sequence-aware cursor that syncs backward until there are no earlier logs to index.
pub(crate) struct BackwardSequenceAwareSyncCursor<T> {
    /// The max chunk size to query for logs.
    /// If in sequence mode, this is the max number of sequences to query.
    /// If in block mode, this is the max number of blocks to query.
    chunk_size: u32,
    /// The latest sequence count querier.
    /// This is used to check if there are new logs to index and to
    /// establish targets to index towards.
    latest_sequence_querier: Arc<dyn SequenceAwareIndexer<T>>,
    /// The lowest block height or sequence of an entity which should be indexed.
    pub lowest_block_height_or_sequence: i64,
    /// A store used to check which logs have already been indexed.
    store: Arc<dyn HyperlaneSequenceAwareIndexerStoreReader<T>>,
    /// A snapshot of the last log to be indexed, or if no indexing has occurred yet,
    /// the initial log to start indexing backward from.
    last_indexed_snapshot: LastIndexedSnapshot,
    /// The current snapshot we're indexing. As this is a backward cursor,
    /// if the last indexed snapshot was sequence 100, this would be sequence 99.
    /// A None value indicates we're fully synced.
    current_indexing_snapshot: Option<TargetSnapshot>,
    /// The mode of indexing to use.
    index_mode: IndexMode,
    /// The domain of the cursor.
    domain: HyperlaneDomain,
    /// Cursor metrics.
    metrics: Arc<CursorMetrics>,
}

impl<T> Debug for BackwardSequenceAwareSyncCursor<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackwardSequenceAwareSyncCursor")
            .field("chunk_size", &self.chunk_size)
            .field("last_indexed_snapshot", &self.last_indexed_snapshot)
            .field("current_indexing_snapshot", &self.current_indexing_snapshot)
            .field("index_mode", &self.index_mode)
            .field("domain", &self.domain)
            .finish()
    }
}

#[derive(Clone)]
pub struct BackwardSequenceAwareSyncCursorParams<T> {
    pub chunk_size: u32,
    pub latest_sequence_querier: Arc<dyn SequenceAwareIndexer<T>>,
    pub lowest_block_height_or_sequence: i64,
    pub store: Arc<dyn HyperlaneSequenceAwareIndexerStoreReader<T>>,
    pub current_sequence_count: u32,
    pub start_block: u32,
    pub index_mode: IndexMode,
    pub metrics_data: MetricsData,
}

impl<T: Debug + Clone + Sync + Send + Indexable + 'static> Debug
    for BackwardSequenceAwareSyncCursorParams<T>
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackwardSequenceAwareSyncCursorParams")
            .field("chunk_size", &self.chunk_size)
            .field(
                "lowest_block_height_or_sequence",
                &self.lowest_block_height_or_sequence,
            )
            .field("current_sequence_count", &self.current_sequence_count)
            .field("start_block", &self.start_block)
            .field("index_mode", &self.index_mode)
            .finish()
    }
}

impl<T: Debug + Clone + Sync + Send + Indexable + 'static> BackwardSequenceAwareSyncCursor<T> {
    #[instrument(ret)]
    pub fn new(params: BackwardSequenceAwareSyncCursorParams<T>) -> Self {
        let BackwardSequenceAwareSyncCursorParams {
            chunk_size,
            latest_sequence_querier,
            lowest_block_height_or_sequence,
            store,
            current_sequence_count,
            start_block,
            index_mode,
            metrics_data,
        } = params;

        // If the current sequence count is 0, we haven't indexed anything yet.
        // Otherwise, consider the current sequence count as the last indexed snapshot,
        // indicating the upper bound of sequences to index.
        let last_indexed_snapshot = LastIndexedSnapshot {
            sequence: (current_sequence_count > 0).then_some(current_sequence_count),
            at_block: start_block,
        };
        let MetricsData { domain, metrics } = metrics_data;

        Self {
            chunk_size,
            latest_sequence_querier,
            lowest_block_height_or_sequence,
            store,
            current_indexing_snapshot: last_indexed_snapshot.previous_target(),
            last_indexed_snapshot,
            index_mode,
            domain,
            metrics,
        }
    }

    /// Get the last indexed sequence or 0 if no logs have been indexed yet.
    pub fn last_sequence(&self) -> u32 {
        self.last_indexed_snapshot.sequence.unwrap_or(0)
    }

    /// Gets the next range of logs to query.
    /// If the cursor is fully synced, this returns None.
    /// Otherwise, it returns the next range to query, either by block or sequence depending on the mode.
    pub async fn get_next_range(&mut self) -> Result<Option<RangeInclusive<u32>>> {
        // Skip any already indexed logs.
        tokio::select! {
            res = self.skip_indexed() => res?,
            // return early to allow the forward cursor to also make progress
            _ = sleep(MAX_BACKWARD_SYNC_BLOCKING_TIME) => { return Ok(None); }
        };

        // If `self.current_indexing_snapshot` is None, we are synced and there are no more ranges to query.
        // Otherwise, we query the next range, searching for logs prior to and including the current indexing snapshot.

        match self.current_indexing_snapshot.as_ref() {
            Some(current_indexing_snapshot) => {
                let range = match &self.index_mode {
                    IndexMode::Block => self.get_next_block_range(current_indexing_snapshot).await,
                    IndexMode::Sequence => {
                        self.get_next_sequence_range(current_indexing_snapshot)
                            .await
                    }
                };
                Ok(range)
            }
            None => Ok(None),
        }
    }

    /// Gets the next block range to index.
    /// Only used in block mode.
    async fn get_next_block_range(
        &self,
        current_indexing_snapshot: &TargetSnapshot,
    ) -> Option<RangeInclusive<u32>> {
        let lowest_block_height_or_sequence = self.get_lowest_block_height_or_sequence().await?;

        // Query the block height range ending at the current_indexing_snapshot's at_block.
        // We assume that chunk size is at least 1 so that the block 0 is indexed
        // together with block 1. That's why we can compare the current block height
        // with the lowest block height with <=.
        if current_indexing_snapshot.at_block <= lowest_block_height_or_sequence {
            // If the current indexing snapshot's block height is less than or equal to the
            // lowest block height, we don't want to index anything below the lowest block height.
            info!(
                current_indexing_snapshot=?current_indexing_snapshot,
                lowest_block_height=lowest_block_height_or_sequence,
                "Current indexing snapshot's block height is less than or equal to the lowest block height, \
                not indexing anything below the lowest block height"
            );
            return None;
        }
        // Query the block range ending at the current_indexing_snapshot's at_block.
        let low = current_indexing_snapshot
            .at_block
            .saturating_sub(self.chunk_size)
            // Use the lowest block height as the low bound of the range
            // if the calculated low is less than the lowest block height.
            .max(lowest_block_height_or_sequence);
        Some(low..=current_indexing_snapshot.at_block)
    }

    /// Gets the next sequence range to index.
    /// Only used in sequence mode.
    async fn get_next_sequence_range(
        &self,
        current_indexing_snapshot: &TargetSnapshot,
    ) -> Option<RangeInclusive<u32>> {
        let lowest_block_height_or_sequence = self.get_lowest_block_height_or_sequence().await?;

        // Query the sequence range ending at the current_indexing_snapshot's sequence.
        // We assume that chunk size is at least 1 so that the sequence 0 is indexed
        // together with sequence 1. That's why we can compare the current sequence
        // with the lowest sequence with <=.
        if current_indexing_snapshot.sequence <= lowest_block_height_or_sequence {
            // If the current indexing snapshot's sequence is less than or equal to the lowest sequence,
            // we don't want to index anything below the lowest sequence.
            info!(
                current_indexing_snapshot=?current_indexing_snapshot,
                lowest_sequence=lowest_block_height_or_sequence,
                "Current indexing snapshot's sequence is less than or equal to the lowest sequence, \
                not indexing anything below the lowest sequence"
            );
            return None;
        }
        let low = current_indexing_snapshot
            .sequence
            .saturating_sub(self.chunk_size)
            // Use the lowest sequence as the low bound of the range
            // if the calculated low is less than the lowest sequence.
            .max(lowest_block_height_or_sequence);
        Some(low..=current_indexing_snapshot.sequence)
    }

    async fn get_lowest_block_height_or_sequence(&self) -> Option<u32> {
        if self.lowest_block_height_or_sequence >= 0 {
            return Some(self.lowest_block_height_or_sequence as u32);
        }

        let (sequence_count, latest_tip) = self
            .latest_sequence_querier
            .latest_sequence_count_and_tip()
            .await
            .ok()?;
        match self.index_mode {
            IndexMode::Block => {
                let lowest_block_height =
                    (latest_tip as i64).saturating_add(self.lowest_block_height_or_sequence);
                if lowest_block_height < 0 {
                    Some(0)
                } else {
                    Some(lowest_block_height as u32)
                }
            }
            IndexMode::Sequence => sequence_count.map(|seq_count| {
                let lowest_sequence_count =
                    (seq_count as i64).saturating_add(self.lowest_block_height_or_sequence);
                if lowest_sequence_count < 0 {
                    0
                } else {
                    lowest_sequence_count as u32
                }
            }),
        }
    }

    /// Reads the DB to check if the current indexing sequence has already been indexed,
    /// iterating until we find a sequence that hasn't been indexed.
    async fn skip_indexed(&mut self) -> Result<()> {
        let prev_indexed_snapshot = self.last_indexed_snapshot.clone();

        // While we're not fully synced, check if the next log we're looking for has been
        // inserted into the db, and update the cursor accordingly.
        while let Some(current_indexing_sequence) =
            self.current_indexing_snapshot.as_ref().map(|s| s.sequence)
        {
            // Require the block number as well.
            if let Some(block_number) = self
                .get_sequence_log_block_number(current_indexing_sequence)
                .await?
            {
                self.last_indexed_snapshot = LastIndexedSnapshot {
                    sequence: Some(current_indexing_sequence),
                    at_block: block_number,
                };

                self.current_indexing_snapshot = self.last_indexed_snapshot.previous_target();

                // Update metrics during fast-forward (actually backward in this case) so that
                // the metrics do not stuck on the last indexed sequence.
                self.update_metrics();
            } else {
                // If the sequence hasn't been indexed, break out of the loop.
                break;
            }
            // We've noticed that this loop can run for a long time because the `await`
            // points never yield.
            // So, to avoid starving other futures in this task, yield to the runtime
            // on each iteration
            tokio::task::yield_now().await;
        }
        if prev_indexed_snapshot != self.last_indexed_snapshot {
            debug!(
                last_indexed_snapshot=?prev_indexed_snapshot,
                current_indexing_snapshot=?self.current_indexing_snapshot,
                "Fast forwarded current sequence to"
            );
        }
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
    /// Only used in sequence mode.
    /// Logs are expected to be sorted by sequence in ascending order and deduplicated.
    ///
    /// Behavior:
    /// - Empty logs are allowed, but no gaps are allowed. The logs must build upon the last indexed snapshot.
    /// - If there are any gaps, the cursor rewinds to the last indexed snapshot, and ranges will be retried.
    fn update_block_range(
        &mut self,
        logs: Vec<(SequenceIndexed<T>, LogMeta)>,
        all_log_sequences: &HashSet<u32>,
        range: RangeInclusive<u32>,
        current_indexing_snapshot: TargetSnapshot,
    ) -> Result<()> {
        // We require no sequence gaps and to build upon the last snapshot.
        // A non-inclusive range is used to allow updates without any logs.
        let expected_sequences = ((current_indexing_snapshot.sequence + 1)
            .saturating_sub(logs.len() as u32)
            ..(current_indexing_snapshot.sequence + 1))
            .collect::<HashSet<_>>();
        if all_log_sequences != &expected_sequences {
            // If there are any missing sequences, rewind to just before the last indexed snapshot.
            // Rewind to the last snapshot.
            self.rewind_due_to_sequence_gaps(&logs, all_log_sequences, &expected_sequences, &range);
            return Ok(());
        }

        let logs_len: u32 = logs.len().try_into()?;

        // If the number of logs, which start at the current sequence and go backwards,
        // exceeds the current indexing snapshot sequence, we've synced everything including
        // sequence 0. Otherwise, we're not fully synced yet.
        self.current_indexing_snapshot = current_indexing_snapshot
            .sequence
            .checked_sub(logs_len)
            .map(|new_current_sequence| TargetSnapshot {
                sequence: new_current_sequence,
                at_block: *range.start(),
            });

        // This means we indexed at least one log that builds on the last snapshot.
        // Recall logs is sorted in ascending order, so the last log is the "oldest" / "earliest"
        // log in the range.
        if let Some(lowest_sequence_log) = logs.first() {
            // Update the last snapshot.
            self.last_indexed_snapshot = LastIndexedSnapshot {
                sequence: Some(lowest_sequence_log.0.sequence),
                at_block: lowest_sequence_log.1.block_number.try_into()?,
            };
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
        current_indexing_snapshot: TargetSnapshot,
    ) -> Result<()> {
        // We require that the range starts at the current sequence.
        // This should always be the case, but to be extra safe we handle this case.
        if *range.end() != current_indexing_snapshot.sequence {
            warn!(
                ?logs,
                ?range,
                current_indexing_snapshot=?self.current_indexing_snapshot,
                last_indexed_snapshot=?self.last_indexed_snapshot,
                "Expected range to end at the current sequence",
            );
            self.rewind();
            return Ok(());
        }

        // We require that we've gotten all sequences in the range.
        let expected_sequences = range.clone().collect::<HashSet<_>>();
        if all_log_sequences != &expected_sequences {
            // If there are any missing sequences, rewind to just before the last indexed snapshot.
            // Rewind to the last snapshot.
            self.rewind_due_to_sequence_gaps(&logs, all_log_sequences, &expected_sequences, &range);
            return Ok(());
        }

        // If we've gotten here, it means we indexed the entire range.
        // We update the last snapshot accordingly and set ourselves up to index the previous sequence.
        // Recall logs is sorted in ascending order, so the first log is the lowest sequence.
        let Some(lowest_sequence_log) = logs.first() else {
            // Sequence range indexing should never have empty ranges,
            // but to be safe we handle this anyways.
            warn!(
                ?logs,
                ?range,
                current_indexing_snapshot=?self.current_indexing_snapshot,
                last_indexed_snapshot=?self.last_indexed_snapshot,
                "Expected non-empty logs and range in sequence mode",
            );
            return Ok(());
        };

        // Update the last indexed snapshot.
        self.last_indexed_snapshot = LastIndexedSnapshot {
            sequence: Some(lowest_sequence_log.0.sequence),
            at_block: lowest_sequence_log.1.block_number.try_into()?,
        };
        // Position the current snapshot to the previous sequence.
        self.current_indexing_snapshot = self.last_indexed_snapshot.previous_target();

        Ok(())
    }

    /// Rewinds the cursor to target immediately preceding the last indexed snapshot,
    /// and logs the inconsistencies.
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
            "Log sequences don't exactly match the expected sequence range, rewinding to last indexed snapshot",
        );
        // Rewind to the last snapshot.
        self.rewind();
    }

    fn rewind(&mut self) {
        self.current_indexing_snapshot = self.last_indexed_snapshot.previous_target();
    }

    /// Updates the cursor metrics.
    fn update_metrics(&self) {
        let labels = hashmap! {
            "event_type" => T::name(),
            "chain" => self.domain.name(),
            "cursor_type" => "backward_sequenced",
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
    }
}

#[async_trait]
impl<T: Debug + Clone + Sync + Send + Indexable + 'static> ContractSyncCursor<T>
    for BackwardSequenceAwareSyncCursor<T>
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

    fn latest_queried_block(&self) -> u32 {
        self.current_indexing_snapshot
            .as_ref()
            .map(|snapshot| snapshot.at_block)
            .unwrap_or(self.last_indexed_snapshot.at_block)
    }

    /// Updates the cursor with the logs that were found in the range.
    ///
    /// Inconsistencies in the logs are not considered errors, instead they're handled by rewinding the cursor
    /// to retry ranges.
    ///
    /// ## logs
    /// The logs to ingest. If any logs are duplicated or their sequence is higher than the current indexing snapshot,
    /// they are filtered out.
    #[instrument(err, ret, skip(logs), fields(range=?range, logs=?logs.iter().map(|(log, _)| log.sequence).collect::<Vec<_>>()))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn update(
        &mut self,
        logs: Vec<(Indexed<T>, LogMeta)>,
        range: RangeInclusive<u32>,
    ) -> Result<()> {
        self.update_metrics();
        let Some(current_indexing_snapshot) = self.current_indexing_snapshot.clone() else {
            // We're synced, no need to update at all.
            return Ok(());
        };

        // Remove any duplicates, filter out any logs with a higher sequence than our
        // current snapshot, and sort in ascending order.
        let logs = indexed_to_sequence_indexed_array(logs)?
            .into_iter()
            .unique_by(|(log, _)| log.sequence)
            .filter(|(log, _)| log.sequence <= current_indexing_snapshot.sequence)
            .sorted_by_key(|(log, _)| log.sequence)
            .collect::<Vec<_>>();
        let all_log_sequences = logs
            .iter()
            .map(|(log, _)| log.sequence)
            .collect::<HashSet<_>>();

        match &self.index_mode {
            IndexMode::Sequence => self.update_sequence_range(
                logs,
                &all_log_sequences,
                range,
                current_indexing_snapshot,
            )?,
            IndexMode::Block => {
                self.update_block_range(logs, &all_log_sequences, range, current_indexing_snapshot)?
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use hyperlane_core::HyperlaneDomain;

    use super::super::forward::test::*;
    use super::*;

    const INITIAL_CURRENT_INDEXING_SNAPSHOT: TargetSnapshot = TargetSnapshot {
        sequence: 99,
        at_block: 1000,
    };
    const INITIAL_LAST_INDEXED_SNAPSHOT: LastIndexedSnapshot = LastIndexedSnapshot {
        sequence: Some(INITIAL_CURRENT_INDEXING_SNAPSHOT.sequence + 1),
        at_block: INITIAL_CURRENT_INDEXING_SNAPSHOT.at_block,
    };

    // Start at sequence 101 to illustrate fast forwarding works
    const INITIAL_SEQUENCE_COUNT: u32 = 101;
    const INITIAL_START_BLOCK: u32 = 1001;

    /// Returns a cursor with the current indexing snapshot as INITIAL_CURRENT_INDEXING_SNAPSHOT.
    async fn get_test_backward_sequence_aware_sync_cursor(
        mode: IndexMode,
        chunk_size: u32,
        lowest_block_height_or_sequence: i64,
    ) -> BackwardSequenceAwareSyncCursor<MockSequencedData> {
        let latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
            latest_sequence_count: Some(100),
            tip: 100,
        });

        let db = Arc::new(MockHyperlaneSequenceAwareIndexerStore {
            logs: vec![
                (
                    MockSequencedData::new(INITIAL_LAST_INDEXED_SNAPSHOT.sequence.unwrap()),
                    log_meta_with_block(INITIAL_LAST_INDEXED_SNAPSHOT.at_block.into()),
                ),
                (
                    MockSequencedData::new(INITIAL_SEQUENCE_COUNT),
                    log_meta_with_block(INITIAL_START_BLOCK.into()),
                ),
                (MockSequencedData::new(102), log_meta_with_block(1002)),
            ],
        });

        let metrics_data = MetricsData {
            domain: HyperlaneDomain::new_test_domain("test"),
            metrics: Arc::new(mock_cursor_metrics()),
        };
        let params = BackwardSequenceAwareSyncCursorParams {
            chunk_size,
            latest_sequence_querier,
            lowest_block_height_or_sequence,
            store: db,
            current_sequence_count: INITIAL_SEQUENCE_COUNT,
            start_block: INITIAL_START_BLOCK,
            index_mode: mode,
            metrics_data,
        };
        let mut cursor = BackwardSequenceAwareSyncCursor::new(params);

        // Skip any already indexed logs and sanity check we start at the correct spot.
        cursor.skip_indexed().await.unwrap();
        assert_eq!(
            cursor.current_indexing_snapshot,
            Some(INITIAL_CURRENT_INDEXING_SNAPSHOT),
        );
        assert_eq!(cursor.last_indexed_snapshot, INITIAL_LAST_INDEXED_SNAPSHOT);

        cursor
    }

    mod block_range {
        use super::*;

        const INDEX_MODE: IndexMode = IndexMode::Block;
        const CHUNK_SIZE: u32 = 100;
        const LOWEST_BLOCK_HEIGHT: i64 = 0;

        async fn get_cursor() -> BackwardSequenceAwareSyncCursor<MockSequencedData> {
            get_test_backward_sequence_aware_sync_cursor(
                INDEX_MODE,
                CHUNK_SIZE,
                LOWEST_BLOCK_HEIGHT,
            )
            .await
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_normal_indexing() {
            let mut cursor = get_cursor().await;

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 900..=1000;
            assert_eq!(range, expected_range);

            // Calling get_next_range again should yield the same range.
            let range = cursor.get_next_range().await.unwrap().unwrap();
            assert_eq!(range, expected_range);

            // Update the cursor with some found logs.
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(97).into(), log_meta_with_block(970)),
                        (MockSequencedData::new(98).into(), log_meta_with_block(980)),
                        (MockSequencedData::new(99).into(), log_meta_with_block(990)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the previous sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 96,
                    at_block: 900,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(97),
                    at_block: 970,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_multiple_ranges() {
            let mut cursor = get_cursor().await;

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 900..=1000;
            assert_eq!(range, expected_range);

            // Update the cursor with no found logs.
            cursor.update(vec![], expected_range).await.unwrap();

            // Expect the cursor to have moved the current indexing snapshot's block number (but not sequence),
            // and made no changes to the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 99,
                    at_block: 900,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(100),
                    at_block: 1000,
                }
            );

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 800..=900;
            assert_eq!(range, expected_range);

            // Update the cursor with some found logs now.
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(96).into(), log_meta_with_block(850)),
                        (MockSequencedData::new(97).into(), log_meta_with_block(860)),
                        (MockSequencedData::new(98).into(), log_meta_with_block(870)),
                        (MockSequencedData::new(99).into(), log_meta_with_block(880)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the previous sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 95,
                    at_block: 800,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(96),
                    at_block: 850,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_rewinds_for_sequence_gap() {
            let mut cursor = get_cursor().await;

            async fn update_and_expect_rewind(
                cur: &mut BackwardSequenceAwareSyncCursor<MockSequencedData>,
                logs: Vec<(Indexed<MockSequencedData>, LogMeta)>,
            ) {
                // For a more rigorous test case, first do a range where no logs are found,
                // then in the next range there are issues, and we should rewind to the last indexed snapshot.

                // Expect the range to be:
                // (current - chunk_size, current)
                let range = cur.get_next_range().await.unwrap().unwrap();
                let expected_range = 900..=1000;
                assert_eq!(range, expected_range);

                // Update the cursor with no found logs.
                cur.update(vec![], expected_range).await.unwrap();

                // Expect the cursor to have moved the current indexing snapshot's block number (but not sequence),
                // and made no changes to the last indexed snapshot.
                assert_eq!(
                    cur.current_indexing_snapshot,
                    Some(TargetSnapshot {
                        sequence: 99,
                        at_block: 900,
                    })
                );
                assert_eq!(
                    cur.last_indexed_snapshot,
                    LastIndexedSnapshot {
                        sequence: Some(100),
                        at_block: 1000,
                    }
                );

                // Expect the range to be:
                // (start, tip)
                let range = cur.get_next_range().await.unwrap().unwrap();
                let expected_range = 800..=900;
                assert_eq!(range, expected_range);

                // Update the cursor, expecting a rewind now
                cur.update(logs, expected_range).await.unwrap();

                // Expect the cursor rewound to just prior to the last indexed snapshot.
                assert_eq!(
                    cur.current_indexing_snapshot,
                    Some(TargetSnapshot {
                        sequence: 99,
                        at_block: 1000,
                    })
                );
                assert_eq!(
                    cur.last_indexed_snapshot,
                    LastIndexedSnapshot {
                        sequence: Some(100),
                        at_block: 1000,
                    }
                );
            }

            // Not building upon last snapshot
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(96).into(), log_meta_with_block(850)),
                    (MockSequencedData::new(97).into(), log_meta_with_block(860)),
                    (MockSequencedData::new(98).into(), log_meta_with_block(870)),
                ],
            )
            .await;

            // Now with a gap, missing 98
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(96).into(), log_meta_with_block(850)),
                    (MockSequencedData::new(97).into(), log_meta_with_block(860)),
                    (MockSequencedData::new(99).into(), log_meta_with_block(890)),
                ],
            )
            .await;
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_handles_unexpected_logs() {
            let mut cursor = get_cursor().await;

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 900..=1000;
            assert_eq!(range, expected_range);

            // Update the cursor with some partially bogus logs:
            // - Three logs of sequence 99, i.e. duplicated
            // - A log at sequence 100, which was already indexed and should be ignored
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(99).into(), log_meta_with_block(990)),
                        (MockSequencedData::new(99).into(), log_meta_with_block(990)),
                        (
                            MockSequencedData::new(100).into(),
                            log_meta_with_block(1000),
                        ),
                        (MockSequencedData::new(99).into(), log_meta_with_block(990)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the previous sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 98,
                    at_block: 900,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(99),
                    at_block: 990,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_stops_after_indexing_sequence_0() {
            let mut cursor = get_cursor().await;

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 900..=1000;
            assert_eq!(range, expected_range);

            // Update the with all the missing logs.
            cursor
                .update(
                    (0..=99)
                        .map(|i| {
                            (
                                MockSequencedData::new(i).into(),
                                log_meta_with_block(900 + i as u64),
                            )
                        })
                        .collect(),
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to indicate that it's fully synced.
            assert_eq!(cursor.current_indexing_snapshot, None,);
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(0),
                    at_block: 900,
                }
            );

            // Expect the range to be None
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_skip_indexed_when_fully_synced() {
            let latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(5),
                tip: 100,
            });

            let db = Arc::new(MockHyperlaneSequenceAwareIndexerStore {
                logs: (0..=INITIAL_SEQUENCE_COUNT)
                    .map(|i| {
                        (
                            MockSequencedData::new(i),
                            log_meta_with_block(900 + i as u64),
                        )
                    })
                    .collect(),
            });

            let metrics_data = MetricsData {
                domain: HyperlaneDomain::new_test_domain("test"),
                metrics: Arc::new(mock_cursor_metrics()),
            };

            let params = BackwardSequenceAwareSyncCursorParams {
                chunk_size: CHUNK_SIZE,
                latest_sequence_querier,
                lowest_block_height_or_sequence: LOWEST_BLOCK_HEIGHT,
                store: db,
                current_sequence_count: INITIAL_SEQUENCE_COUNT,
                start_block: INITIAL_START_BLOCK,
                index_mode: INDEX_MODE,
                metrics_data,
            };
            let mut cursor = BackwardSequenceAwareSyncCursor::new(params);

            // We're fully synced, so expect no range
            assert_eq!(cursor.get_next_range().await.unwrap(), None);
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_stops_after_indexing_lowest_block_height() {
            let lowest_block_height = 942;

            let mut cursor = get_test_backward_sequence_aware_sync_cursor(
                INDEX_MODE,
                CHUNK_SIZE,
                lowest_block_height,
            )
            .await;

            // Expect the range to be:
            // (lowest_block_height, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 942..=1000;
            assert_eq!(range, expected_range);

            // Update the cursor with all the missing logs.
            cursor
                .update(
                    range
                        .map(|block| {
                            (
                                MockSequencedData::new(block - 900).into(),
                                log_meta_with_block(block as u64),
                            )
                        })
                        .collect(),
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to indicate that it stopped at the lowest block height.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 41,
                    at_block: 942,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(42),
                    at_block: 942,
                }
            );

            // Expect the range to be None since we don't want to go below the lowest block height.
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_does_not_stop_before_indexing_block_higher_than_lowest() {
            let chunk_size = 50;
            let lowest_block_height = 942;

            let mut cursor = get_test_backward_sequence_aware_sync_cursor(
                INDEX_MODE,
                chunk_size,
                lowest_block_height,
            )
            .await;

            // Expect the range to be:
            // (current - chunk_size, current)
            // since cursor does not reach the lowest block height at this round
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 950..=1000;
            assert_eq!(range, expected_range);

            // Update the cursor with all the missing logs.
            cursor
                .update(
                    range
                        .map(|block| {
                            (
                                MockSequencedData::new(block - 900).into(),
                                log_meta_with_block(block as u64),
                            )
                        })
                        .collect(),
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to indicate that synced up to the latest block height it could.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 49,
                    at_block: 950,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(50),
                    at_block: 950,
                }
            );

            // Expect the range to stop at the lowest block height even if the range
            // is tighter than the chunk size.
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, Some(942..=950));
        }
    }

    mod sequence_range {
        use super::*;

        const INDEX_MODE: IndexMode = IndexMode::Sequence;
        const CHUNK_SIZE: u32 = 5;
        const LOWEST_SEQUENCE: i64 = 0;

        async fn get_cursor() -> BackwardSequenceAwareSyncCursor<MockSequencedData> {
            get_test_backward_sequence_aware_sync_cursor(INDEX_MODE, CHUNK_SIZE, LOWEST_SEQUENCE)
                .await
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_normal_indexing() {
            let mut cursor = get_cursor().await;

            // We should have fast forwarded to sequence 99, block 1000
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 99,
                    at_block: 1000,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(100),
                    at_block: 1000,
                }
            );

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 94..=99;
            assert_eq!(range, expected_range);

            // Calling get_next_range again should yield the same range.
            let range = cursor.get_next_range().await.unwrap().unwrap();
            assert_eq!(range, expected_range);

            // Update the cursor with some found logs. These have some duplicates
            // and are not sorted, and we expect the cursor to handle this.
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(95).into(), log_meta_with_block(950)),
                        (MockSequencedData::new(96).into(), log_meta_with_block(960)),
                        (MockSequencedData::new(97).into(), log_meta_with_block(970)),
                        // Add a duplicate here
                        (MockSequencedData::new(98).into(), log_meta_with_block(980)),
                        (MockSequencedData::new(98).into(), log_meta_with_block(980)),
                        (MockSequencedData::new(99).into(), log_meta_with_block(990)),
                        // Put this out of order
                        (MockSequencedData::new(94).into(), log_meta_with_block(940)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the previous sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 93,
                    at_block: 940,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(94),
                    at_block: 940,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_rewinds_if_updated_with_no_logs() {
            let mut cursor = get_cursor().await;

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 94..=99;
            assert_eq!(range, expected_range);

            // Update the cursor with no found logs.
            cursor.update(vec![], expected_range).await.unwrap();

            // Expect the cursor to have "rewound", i.e. no changes to the current indexing snapshot or last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 99,
                    at_block: 1000,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(100),
                    at_block: 1000,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_rewinds_if_gap_or_unexpected_logs() {
            // Starts with current snapshot at sequence 99, block 1000
            let mut cursor = get_cursor().await;

            async fn update_and_expect_rewind(
                cur: &mut BackwardSequenceAwareSyncCursor<MockSequencedData>,
                logs: Vec<(Indexed<MockSequencedData>, LogMeta)>,
            ) {
                // Expect the range to be:
                // (current - chunk_size, current)
                let range = cur.get_next_range().await.unwrap().unwrap();
                let expected_range = 94..=99;
                assert_eq!(range, expected_range);

                // Update the cursor
                cur.update(logs, expected_range).await.unwrap();

                // Expect the cursor to have "rewound", i.e. no changes to the current indexing snapshot or last indexed snapshot.
                assert_eq!(
                    cur.current_indexing_snapshot,
                    Some(TargetSnapshot {
                        sequence: 99,
                        at_block: 1000,
                    })
                );
                assert_eq!(
                    cur.last_indexed_snapshot,
                    LastIndexedSnapshot {
                        sequence: Some(100),
                        at_block: 1000,
                    }
                );
            }

            // First, try without building upon the last snapshot
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(94).into(), log_meta_with_block(940)),
                    (MockSequencedData::new(95).into(), log_meta_with_block(950)),
                    (MockSequencedData::new(96).into(), log_meta_with_block(960)),
                    (MockSequencedData::new(98).into(), log_meta_with_block(980)),
                ],
            )
            .await;

            // This time with a gap (missing 97)
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(94).into(), log_meta_with_block(940)),
                    (MockSequencedData::new(95).into(), log_meta_with_block(950)),
                    (MockSequencedData::new(96).into(), log_meta_with_block(960)),
                    (MockSequencedData::new(98).into(), log_meta_with_block(980)),
                    (MockSequencedData::new(99).into(), log_meta_with_block(990)),
                ],
            )
            .await;

            // This time building upon the last snapshot, but the first sequence in the range isn't present
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(95).into(), log_meta_with_block(950)),
                    (MockSequencedData::new(96).into(), log_meta_with_block(960)),
                    (MockSequencedData::new(97).into(), log_meta_with_block(970)),
                    (MockSequencedData::new(98).into(), log_meta_with_block(980)),
                    (MockSequencedData::new(99).into(), log_meta_with_block(990)),
                ],
            )
            .await;

            // An unexpected log, sequence 93
            update_and_expect_rewind(
                &mut cursor,
                vec![
                    (MockSequencedData::new(93).into(), log_meta_with_block(940)),
                    (MockSequencedData::new(94).into(), log_meta_with_block(950)),
                    (MockSequencedData::new(95).into(), log_meta_with_block(950)),
                    (MockSequencedData::new(96).into(), log_meta_with_block(960)),
                    (MockSequencedData::new(97).into(), log_meta_with_block(970)),
                    (MockSequencedData::new(98).into(), log_meta_with_block(980)),
                    (MockSequencedData::new(99).into(), log_meta_with_block(990)),
                ],
            )
            .await;
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_stops_after_indexing_sequence_0() {
            let mut cursor = get_cursor().await;

            // Set the chunk size to 100 to make it easier to test.
            cursor.chunk_size = 100;

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 0..=99;
            assert_eq!(range, expected_range);

            // Update the with all the missing logs.
            cursor
                .update(
                    range
                        .map(|i| {
                            (
                                MockSequencedData::new(i).into(),
                                log_meta_with_block(900 + i as u64),
                            )
                        })
                        .collect(),
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to indicate that it's fully synced.
            assert_eq!(cursor.current_indexing_snapshot, None);
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(0),
                    at_block: 900,
                }
            );

            // Expect the range to be None
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_stops_after_indexing_lowest_sequence() {
            let chunk_size = 60;
            let lowest_sequence = 42;

            let mut cursor = get_test_backward_sequence_aware_sync_cursor(
                INDEX_MODE,
                chunk_size,
                lowest_sequence,
            )
            .await;

            // Expect the range to be:
            // (lowest_sequence, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 42..=99;
            assert_eq!(range, expected_range);

            // Update the with all the missing logs.
            cursor
                .update(
                    range
                        .map(|i| {
                            (
                                MockSequencedData::new(i).into(),
                                log_meta_with_block(900 + i as u64),
                            )
                        })
                        .collect(),
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to indicate that it stopped at the lowest sequence.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 41,
                    at_block: 942
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(42),
                    at_block: 942
                }
            );

            // Expect the range to be None since we don't want to go below the lowest sequence.
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_does_not_stop_before_indexing_sequence_higher_than() {
            let chunk_size = 50;
            let lowest_sequence = 42;

            let mut cursor = get_test_backward_sequence_aware_sync_cursor(
                INDEX_MODE,
                chunk_size,
                lowest_sequence,
            )
            .await;

            // Expect the range to be:
            // (current - chunk_size, current)
            // since cursor does not reach the lowest sequence at this round
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = (99 - chunk_size)..=99;
            assert_eq!(range, expected_range);

            // Update the with all the missing logs.
            cursor
                .update(
                    range
                        .map(|i| {
                            (
                                MockSequencedData::new(i).into(),
                                log_meta_with_block(900 + i as u64),
                            )
                        })
                        .collect(),
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to indicate that synced up to the latest sequence it could
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 48,
                    at_block: 949
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(49),
                    at_block: 949,
                }
            );

            // Expect the range to stop at the lowest sequence even if the range
            // is tighter than the chunk size
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, Some(42..=48));
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_negative_block_height() {
            let chunk_size = 50;
            let lowest_sequence = -10;

            let mut cursor = get_test_backward_sequence_aware_sync_cursor(
                INDEX_MODE,
                chunk_size,
                lowest_sequence,
            )
            .await;

            // Expect the range to be:
            // (current - chunk_size, current)
            // since cursor does not reach the lowest sequence at this round
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = (90)..=99;
            assert_eq!(range, expected_range);

            // Update the with all the missing logs.
            cursor
                .update(
                    range
                        .map(|i| {
                            (
                                MockSequencedData::new(i).into(),
                                log_meta_with_block(900 + i as u64),
                            )
                        })
                        .collect(),
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to indicate that synced up to the latest sequence it could
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(TargetSnapshot {
                    sequence: 89,
                    at_block: 990
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                LastIndexedSnapshot {
                    sequence: Some(90),
                    at_block: 990,
                }
            );

            // should be no more ranges because we've indexed everything
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);
        }
    }
}
