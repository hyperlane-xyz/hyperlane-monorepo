use std::{
    cmp::Ordering, collections::HashSet, fmt::Debug, ops::RangeInclusive, sync::Arc, time::Duration,
};

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractSyncCursor, CursorAction,
    HyperlaneSequenceIndexerStore, IndexMode, LogMeta, SequenceAwareIndexer, Sequenced,
};
use itertools::Itertools;
use tracing::{debug, warn};

use super::{LastIndexedSnapshot, TargetSnapshot};

/// A sequence-aware cursor that syncs forwards in perpetuity.
#[derive(Debug)]
pub(crate) struct ForwardSequenceAwareSyncCursor<T> {
    chunk_size: u32,
    latest_sequence_querier: Arc<dyn SequenceAwareIndexer<T>>,
    db: Arc<dyn HyperlaneSequenceIndexerStore<T>>,
    last_indexed_snapshot: LastIndexedSnapshot,
    /// The current / next snapshot that is the starting point for the next range.
    current_indexing_snapshot: TargetSnapshot,
    target_snapshot: Option<TargetSnapshot>,
    index_mode: IndexMode,
}

impl<T: Sequenced + Debug> ForwardSequenceAwareSyncCursor<T> {
    pub fn new(
        chunk_size: u32,
        latest_sequence_querier: Arc<dyn SequenceAwareIndexer<T>>,
        db: Arc<dyn HyperlaneSequenceIndexerStore<T>>,
        next_sequence: u32,
        start_block: u32,
        index_mode: IndexMode,
    ) -> Self {
        let last_indexed_snapshot = LastIndexedSnapshot {
            sequence: if next_sequence == 0 {
                None
            } else {
                Some(next_sequence.saturating_sub(1))
            },
            at_block: start_block,
        };

        Self {
            chunk_size,
            latest_sequence_querier,
            db,
            last_indexed_snapshot,
            current_indexing_snapshot: TargetSnapshot {
                sequence: next_sequence,
                at_block: start_block,
            },
            target_snapshot: None,
            index_mode,
        }
    }

    pub async fn get_next_range(&mut self) -> ChainResult<Option<RangeInclusive<u32>>> {
        // Fast forward the cursor to the latest indexed sequence.
        self.fast_forward().await?;

        let (Some(onchain_sequence_count), tip) = self
            .latest_sequence_querier
            .latest_sequence_count_and_tip()
            .await?
        else {
            return Ok(None);
        };
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

                // Set the target to the latest sequence and tip.
                // We don't necessarily expect to hit this target in the next query (because we
                // have limits to the range size based off the chunk size), but we will use it
                // as an eventual target.
                self.target_snapshot = Some(TargetSnapshot {
                    // Minus one because this is the sequence we're targeting, not the count.
                    sequence: target_sequence,
                    at_block: tip,
                });

                match &self.index_mode {
                    IndexMode::Block => {
                        // Query the block range starting from the current_indexing_snapshot's at_block.
                        Some(
                            self.current_indexing_snapshot.at_block
                                ..=u32::min(
                                    self.current_indexing_snapshot.at_block + self.chunk_size,
                                    tip,
                                ),
                        )
                    }
                    IndexMode::Sequence => {
                        // Query the sequence range starting from the cursor count.
                        Some(
                            current_sequence
                                ..=u32::min(target_sequence, current_sequence + self.chunk_size),
                        )
                    }
                }
            }
            Ordering::Greater => {
                // Providers may be internally inconsistent, e.g. RPC request A could hit a node
                // whose tip is N and subsequent RPC request B could hit a node whose tip is < N.
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

    async fn fast_forward(&mut self) -> ChainResult<()> {
        // Check if any new logs have been inserted into the DB,
        // and update the cursor accordingly.
        while self
            .db
            .retrieve_by_sequence(self.current_indexing_snapshot.sequence)
            .await
            .map_err(|_e| ChainCommunicationError::from_other_str("todo"))?
            .is_some()
        {
            if let Some(block_number) = self
                .db
                .retrieve_log_block_number(self.current_indexing_snapshot.sequence)
                .await
                .map_err(|_e| ChainCommunicationError::from_other_str("todo"))?
            {
                self.last_indexed_snapshot = LastIndexedSnapshot {
                    sequence: Some(self.current_indexing_snapshot.sequence),
                    at_block: block_number.try_into().expect("todo"),
                };
                self.current_indexing_snapshot = self.last_indexed_snapshot.next_target();

                debug!(
                    last_indexed_snapshot=?self.last_indexed_snapshot,
                    current_indexing_snapshot=?self.current_indexing_snapshot,
                    "Fast forwarding current sequence"
                );
            }
        }

        Ok(())
    }
}

#[async_trait]
impl<T: Sequenced + Debug> ContractSyncCursor<T> for ForwardSequenceAwareSyncCursor<T> {
    // TODO need to revisit
    async fn next_action(&mut self) -> ChainResult<(CursorAction, Duration)> {
        // TODO: Fix ETA calculation
        let eta = Duration::from_secs(0);
        if let Some(range) = self.get_next_range().await? {
            Ok((CursorAction::Query(range), eta))
        } else {
            // TODO: Define the sleep time from interval flag
            Ok((CursorAction::Sleep(Duration::from_secs(5)), eta))
        }
    }

    // TODO need to revisit
    fn latest_block(&self) -> u32 {
        0
    }

    /// Inconsistencies in the logs are not considered errors, instead they're handled
    /// by rewinding the cursor.
    async fn update(&mut self, logs: Vec<(T, LogMeta)>, range: RangeInclusive<u32>) -> Result<()> {
        // Pretty much:
        // If sequence based indexing, we expect a full match here.
        // If block based indexing, we're tolerant of missing logs *if* the target snapshot's at_block exceeds the range's end.

        // Remove any duplicates, filter out any logs preceding our current snapshot, and sort in ascending order.
        let logs = logs
            .into_iter()
            .dedup_by(|(log_a, _), (log_b, _)| log_a.sequence() == log_b.sequence())
            .filter(|(log, _)| log.sequence() >= self.current_indexing_snapshot.sequence)
            .sorted_by(|(log_a, _), (log_b, _)| log_a.sequence().cmp(&log_b.sequence()))
            .collect::<Vec<_>>();

        let all_log_sequences = logs
            .iter()
            .map(|(log, _)| log.sequence())
            .collect::<HashSet<_>>();

        match &self.index_mode {
            IndexMode::Sequence => {
                // We require that we've gotten all sequences in the range.
                let expected_sequences = range.clone().collect::<HashSet<_>>();
                if all_log_sequences != expected_sequences {
                    warn!(
                        all_log_sequences=?all_log_sequences.iter().sorted().collect::<Vec<_>>(),
                        expected_sequences=?expected_sequences.iter().sorted().collect::<Vec<_>>(),
                        expected_sequence_range=?range,
                        missing_expected_sequences=?expected_sequences.difference(&all_log_sequences).sorted().collect::<Vec<_>>(),
                        unexpected_sequences=?all_log_sequences.difference(&expected_sequences).sorted().collect::<Vec<_>>(),
                        ?logs,
                        current_indexing_snapshot=?self.current_indexing_snapshot,
                        last_indexed_snapshot=?self.last_indexed_snapshot,
                        target_snapshot=?self.target_snapshot,
                        "Log sequences don't exactly match the expected sequence range, rewinding to last snapshot",
                    );
                    // If there are any missing sequences, rewind to the last snapshot.
                    self.current_indexing_snapshot = self.last_indexed_snapshot.next_target();
                    return Ok(());
                }

                // This means we indexed the entire range.
                // We update the last snapshot accordingly and set ourselves up for the next sequence.
                // If we've gotten this far, we can assume that logs is non-empty.
                let last_log = logs.last().expect("Logs must be non-empty");
                // Update the last snapshot accordingly.
                self.last_indexed_snapshot = LastIndexedSnapshot {
                    sequence: Some(last_log.0.sequence()),
                    at_block: last_log.1.block_number.try_into().expect("todo"),
                };
                // Position the current snapshot to the next sequence.
                self.current_indexing_snapshot = self.last_indexed_snapshot.next_target();
            }
            IndexMode::Block => {
                // If the first log we got is a gap since the last snapshot, or there are gaps
                // in the logs, rewind to the last snapshot.

                // We require no sequence gaps and to build upon the last snapshot.
                let expected_sequences = (self.current_indexing_snapshot.sequence
                    ..(self.current_indexing_snapshot.sequence + logs.len() as u32))
                    .collect::<HashSet<_>>();
                if all_log_sequences != expected_sequences {
                    warn!(
                        all_log_sequences=?all_log_sequences.iter().sorted().collect::<Vec<_>>(),
                        expected_sequences=?expected_sequences.iter().sorted().collect::<Vec<_>>(),
                        expected_sequence_range=?range,
                        missing_expected_sequences=?expected_sequences.difference(&all_log_sequences).sorted().collect::<Vec<_>>(),
                        unexpected_sequences=?all_log_sequences.difference(&expected_sequences).sorted().collect::<Vec<_>>(),
                        ?logs,
                        current_indexing_snapshot=?self.current_indexing_snapshot,
                        last_indexed_snapshot=?self.last_indexed_snapshot,
                        target_snapshot=?self.target_snapshot,
                        "Log sequences don't exactly match the expected sequence range, rewinding to last snapshot",
                    );
                    // If there are any missing sequences, rewind to just after the last indexed snapshot.
                    self.current_indexing_snapshot = self.last_indexed_snapshot.next_target();
                    return Ok(());
                }

                self.current_indexing_snapshot = TargetSnapshot {
                    sequence: self.current_indexing_snapshot.sequence + logs.len() as u32,
                    at_block: *range.end(),
                };

                // This means we indexed at least one log that builds on the last snapshot.
                if let Some(last_log) = logs.last() {
                    // Update the last snapshot.
                    self.last_indexed_snapshot = LastIndexedSnapshot {
                        sequence: Some(last_log.0.sequence()),
                        at_block: last_log.1.block_number.try_into().expect("todo"),
                    };

                    let target_snapshot = self.target_snapshot.as_ref().expect("todo");
                    // If the end block is >= the target block and we haven't reached the target sequence,
                    // rewind to just after the last indexed snapshot.
                    if last_log.0.sequence() < target_snapshot.sequence
                        && *range.end() >= target_snapshot.at_block
                    {
                        warn!(
                            ?last_log,
                            ?logs,
                            current_indexing_snapshot=?self.current_indexing_snapshot,
                            last_indexed_snapshot=?self.last_indexed_snapshot,
                            target_snapshot=?self.target_snapshot,
                            "Log sequences don't match expected sequence range, rewinding to last snapshot",
                        );
                        self.current_indexing_snapshot = self.last_indexed_snapshot.next_target();
                        return Ok(());
                    }
                } else if *range.end() >= self.target_snapshot.as_ref().expect("todo").at_block {
                    // Hitting this path means that we didn't get any logs, previously didn't reach the target,
                    // and the end block is >= the target block.
                    // Rewind to just after the last indexed snapshot.
                    warn!(
                        ?logs,
                        current_indexing_snapshot=?self.current_indexing_snapshot,
                        last_indexed_snapshot=?self.last_indexed_snapshot,
                        target_snapshot=?self.target_snapshot,
                        "Log sequences don't match expected sequence range, rewinding to last snapshot",
                    );
                    self.current_indexing_snapshot = self.last_indexed_snapshot.next_target();
                    return Ok(());
                }
            }
        };
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod test {
    use derive_new::new;
    use hyperlane_core::{HyperlaneLogStore, Indexer};

    use super::*;

    #[derive(Debug, Clone)]
    pub struct MockLatestSequenceQuerier {
        pub latest_sequence_count: Option<u32>,
        pub tip: u32,
    }

    #[async_trait]
    impl<T> SequenceAwareIndexer<T> for MockLatestSequenceQuerier
    where
        T: Sequenced + Debug,
    {
        async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
            Ok((self.latest_sequence_count, self.tip))
        }
    }

    #[async_trait]
    impl<T> Indexer<T> for MockLatestSequenceQuerier
    where
        T: Sequenced + Debug,
    {
        async fn fetch_logs(&self, _range: RangeInclusive<u32>) -> ChainResult<Vec<(T, LogMeta)>> {
            Ok(vec![])
        }

        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            Ok(self.tip)
        }
    }

    #[derive(Debug, Clone)]
    pub struct MockHyperlaneSequenceIndexerStore<T> {
        pub logs: Vec<(T, LogMeta)>,
    }

    #[async_trait]
    impl<T: Sequenced + Debug> HyperlaneLogStore<T> for MockHyperlaneSequenceIndexerStore<T> {
        async fn store_logs(&self, logs: &[(T, LogMeta)]) -> eyre::Result<u32> {
            Ok(logs.len() as u32)
        }
    }

    #[async_trait]
    impl<T: Sequenced + Debug + Clone> HyperlaneSequenceIndexerStore<T>
        for MockHyperlaneSequenceIndexerStore<T>
    {
        async fn retrieve_by_sequence(&self, sequence: u32) -> eyre::Result<Option<T>> {
            Ok(self
                .logs
                .iter()
                .find(|(log, _)| log.sequence() == sequence)
                .map(|(log, _)| log.clone()))
        }

        async fn retrieve_log_block_number(&self, sequence: u32) -> eyre::Result<Option<u64>> {
            Ok(self
                .logs
                .iter()
                .find(|(log, _)| log.sequence() == sequence)
                .map(|(_, meta)| meta.block_number))
        }
    }

    #[derive(Debug, Clone, new)]
    pub struct MockSequencedData {
        pub sequence: u32,
    }

    impl Sequenced for MockSequencedData {
        fn sequence(&self) -> u32 {
            self.sequence
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

    fn get_test_forward_sequence_aware_sync_cursor(
        mode: IndexMode,
        chunk_size: u32,
    ) -> ForwardSequenceAwareSyncCursor<MockSequencedData> {
        let latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
            latest_sequence_count: Some(5),
            tip: 100,
        });

        let db = Arc::new(MockHyperlaneSequenceIndexerStore {
            logs: vec![
                (MockSequencedData::new(0), log_meta_with_block(50)),
                (MockSequencedData::new(1), log_meta_with_block(60)),
                (MockSequencedData::new(2), log_meta_with_block(70)),
                (MockSequencedData::new(3), log_meta_with_block(80)),
                (MockSequencedData::new(4), log_meta_with_block(90)),
            ],
        });

        ForwardSequenceAwareSyncCursor::new(
            chunk_size,
            latest_sequence_querier,
            db,
            // Start at sequence 3 and block 70 to illustrate fast forwarding
            3,
            70,
            mode,
        )
    }

    mod block_range {
        use super::*;

        const INDEX_MODE: IndexMode = IndexMode::Block;
        const CHUNK_SIZE: u32 = 100;

        async fn get_cursor() -> ForwardSequenceAwareSyncCursor<MockSequencedData> {
            let mut cursor = get_test_forward_sequence_aware_sync_cursor(INDEX_MODE, CHUNK_SIZE);
            // Fast forwarded to sequence 5, block 90
            cursor.fast_forward().await.unwrap();

            cursor
        }

        /// Tests successful fast forwarding & indexing where all ranges return logs.
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_normal_indexing() {
            // Starts with current snapshot at sequence 5, block 90
            let mut cursor = get_cursor().await;

            // We should have fast forwarded to sequence 5, block 90
            assert_eq!(
                cursor.current_indexing_snapshot,
                TargetSnapshot {
                    sequence: 5,
                    at_block: 90,
                }
            );

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
                    vec![(MockSequencedData::new(5), log_meta_with_block(115))],
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
            // Starts with current snapshot at sequence 5, block 90
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
                    vec![(MockSequencedData::new(5), log_meta_with_block(195))],
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
            // Starts with current snapshot at sequence 5, block 90
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
        async fn test_rewinds_for_sequence_gap() {
            // Starts with current snapshot at sequence 5, block 90
            let mut cursor = get_cursor().await;

            // Pretend like the tip is 200, a message occurred at block 150 that's missed,
            // and another message at block 195 is found.

            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                // 3 new messages since we last indexed have come in!
                latest_sequence_count: Some(7),
                tip: 200,
            });

            // Expect the range to be:
            // (start, start + chunk_size)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 90..=190;
            assert_eq!(range, expected_range);

            // Update the cursor with no found logs. We should've found one here though!
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
            cursor
                .update(
                    vec![
                        // There's a gap - we missed a log at sequence 5.
                        (MockSequencedData::new(6), log_meta_with_block(195)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

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

        /// Tests when the cursor is so behind the tip that it'll need to index multiple ranges, but by the time
        /// it gets to the target snapshot, it realizes it missed a log and needs to rewind.
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_handles_unexpected_logs() {
            // Starts with current snapshot at sequence 5, block 90
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

            // Update the cursor with some paritally bogus logs:
            // - A log at sequence 4, which was already indexed and should be ignored
            // - Two logs of sequence 5, i.e. duplicated
            // - A log at sequence 6, which is unexpected, but tolerated nonetheless
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(4), log_meta_with_block(90)),
                        (MockSequencedData::new(5), log_meta_with_block(95)),
                        (MockSequencedData::new(5), log_meta_with_block(95)),
                        (MockSequencedData::new(6), log_meta_with_block(100)),
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
            let mut cursor = get_test_forward_sequence_aware_sync_cursor(INDEX_MODE, CHUNK_SIZE);
            // Fast forwarded to sequence 5, block 90
            cursor.fast_forward().await.unwrap();

            cursor
        }

        /// Tests successful fast forwarding & successful indexing with a correct sequence range.
        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_normal_indexing() {
            let mut cursor = get_cursor().await;

            // We should have fast forwarded to sequence 5, block 90
            assert_eq!(
                cursor.current_indexing_snapshot,
                TargetSnapshot {
                    sequence: 5,
                    at_block: 90,
                }
            );

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
                    vec![(MockSequencedData::new(5), log_meta_with_block(115))],
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
            // Starts with current snapshot at sequence 5, block 90
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
        async fn test_rewinds_if_gap_in_logs() {
            // Starts with current snapshot at sequence 5, block 90
            let mut cursor = get_cursor().await;

            // Update the latest sequence count to 8, expecting to index 3 messages.
            cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
                latest_sequence_count: Some(8),
                tip: 120,
            });

            // Expect the range to be:
            // (new sequence, new sequence)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 5..=7;
            assert_eq!(range, expected_range);

            // Update the cursor with sequence 5 and 7, but not 6.
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(5), log_meta_with_block(115)),
                        (MockSequencedData::new(7), log_meta_with_block(120)),
                    ],
                    expected_range.clone(),
                )
                .await
                .unwrap();

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

            // Try updating the cursor with the correct sequences but also an unexpected sequence.
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(5), log_meta_with_block(115)),
                        (MockSequencedData::new(6), log_meta_with_block(115)),
                        (MockSequencedData::new(7), log_meta_with_block(120)),
                        (MockSequencedData::new(8), log_meta_with_block(125)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to still have "rewound" to the last indexed snapshot.
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
    }
}
