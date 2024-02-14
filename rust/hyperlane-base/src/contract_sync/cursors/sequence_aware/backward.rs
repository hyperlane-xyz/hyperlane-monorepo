//! yo dog

use std::{collections::HashSet, fmt::Debug, ops::RangeInclusive, sync::Arc, time::Duration};

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractSyncCursor, CursorAction,
    HyperlaneSequenceIndexerStore, IndexMode, LogMeta, Sequenced,
};
use itertools::Itertools;
use tracing::{debug, warn};

use super::{OptionalSequenceAwareSyncSnapshot, SequenceAwareSyncSnapshot};

/// A sequence-aware cursor that syncs forwards in perpetuity.
#[derive(Debug)]
pub(crate) struct BackwardSequenceAwareSyncCursor<T> {
    chunk_size: u32,
    db: Arc<dyn HyperlaneSequenceIndexerStore<T>>,
    last_indexed_snapshot: OptionalSequenceAwareSyncSnapshot,
    // None indicates synced
    current_indexing_snapshot: Option<SequenceAwareSyncSnapshot>,
    index_mode: IndexMode,
}

impl<T: Sequenced + Debug> BackwardSequenceAwareSyncCursor<T> {
    pub fn new(
        chunk_size: u32,
        db: Arc<dyn HyperlaneSequenceIndexerStore<T>>,
        current_sequence_count: u32,
        start_block: u32,
        index_mode: IndexMode,
    ) -> Self {
        let last_indexed_snapshot = OptionalSequenceAwareSyncSnapshot {
            sequence: if current_sequence_count == 0 {
                None
            } else {
                Some(current_sequence_count)
            },
            at_block: start_block,
        };

        Self {
            chunk_size,
            db,
            current_indexing_snapshot: last_indexed_snapshot.previous(),
            last_indexed_snapshot,
            index_mode,
        }
    }

    pub async fn get_next_range(&mut self) -> ChainResult<Option<RangeInclusive<u32>>> {
        // Fast forward the cursor if necessary.
        self.fast_forward().await?;

        // `self.current_indexing_snapshot` as None indicates we are synced and there are no more ranges to query.
        Ok(self
            .current_indexing_snapshot
            .as_ref()
            .map(|current_indexing_snapshot| {
                match &self.index_mode {
                    IndexMode::Block => {
                        // Query the block range ending at the current_indexing_snapshot's at_block.
                        current_indexing_snapshot
                            .at_block
                            .saturating_sub(self.chunk_size)
                            ..=current_indexing_snapshot.at_block
                    }
                    IndexMode::Sequence => {
                        // Query the sequence range ending at the current_indexing_snapshot's sequence.
                        current_indexing_snapshot
                            .sequence
                            .saturating_sub(self.chunk_size)
                            ..=current_indexing_snapshot.sequence
                    }
                }
            }))
    }

    async fn fast_forward(&mut self) -> ChainResult<()> {
        // if self.synced {
        //     return Ok(());
        // }

        // // TODO consider indexing start range too?
        // if self.last_indexed_snapshot.sequence == 0 || self.last_indexed_snapshot.at_block == 0 {
        //     self.synced = true;
        //     return Ok(());
        // }

        if let Some(current_indexing_snapshot) = self.current_indexing_snapshot.clone() {
            // Check if any new logs have been inserted into the DB,
            // and update the cursor accordingly.
            while self
                .db
                .retrieve_by_sequence(current_indexing_snapshot.sequence)
                .await
                .map_err(|_e| ChainCommunicationError::from_other_str("todo"))?
                .is_some()
            {
                if let Some(block_number) = self
                    .db
                    .retrieve_log_block_number(current_indexing_snapshot.sequence)
                    .await
                    .map_err(|_e| ChainCommunicationError::from_other_str("todo"))?
                {
                    self.last_indexed_snapshot = OptionalSequenceAwareSyncSnapshot {
                        sequence: Some(current_indexing_snapshot.sequence),
                        at_block: block_number.try_into().expect("todo"),
                    };

                    // Note this is the only difference between this and the forward cursor.
                    // TODO do something leveraging this?
                    self.current_indexing_snapshot = self.last_indexed_snapshot.previous();

                    debug!(
                        last_indexed_snapshot=?self.last_indexed_snapshot,
                        current_indexing_snapshot=?self.current_indexing_snapshot,
                        "Fast forwarding current sequence"
                    );
                }
            }
        }

        Ok(())
    }
}

#[async_trait]
impl<T: Sequenced + Debug> ContractSyncCursor<T> for BackwardSequenceAwareSyncCursor<T> {
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
        // Expect the sequence in the logs to exactly match the range.
        // sequenced_data_logs_matches_range(logs, range.clone())?;

        // self.next_sequence = range.end() + 1;

        // Pretty much:
        // If sequence based indexing, we expect a full match here.
        // If block based indexing, we're tolerant of missing logs *if* the target snapshot's
        // at_block exceeds the range's end.

        let Some(current_indexing_snapshot) = self.current_indexing_snapshot.clone() else {
            // We're synced, no need to update at all.
            return Ok(());
        };

        // Remove any duplicates, filter out any logs with a higher sequance than our
        // current snapshot, and sort in ascending order.
        let logs = logs
            .into_iter()
            .dedup_by(|(log_a, _), (log_b, _)| log_a.sequence() == log_b.sequence())
            .filter(|(log, _)| log.sequence() <= current_indexing_snapshot.sequence)
            .sorted_by(|(log_a, _), (log_b, _)| log_a.sequence().cmp(&log_b.sequence()))
            .collect::<Vec<_>>();

        let all_log_sequences = logs
            .iter()
            .map(|(log, _)| log.sequence())
            .collect::<HashSet<_>>();

        Ok(match &self.index_mode {
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
                        ?current_indexing_snapshot,
                        last_indexed_snapshot=?self.last_indexed_snapshot,
                        "Log sequences don't exactly match the expected sequence range, rewinding to last snapshot",
                    );
                    // Rewind to the last snapshot.
                    self.current_indexing_snapshot = self.last_indexed_snapshot.previous();
                    return Ok(());
                }

                // This means we indexed the entire range.
                // We update the last snapshot accordingly and set ourselves up for the next sequence.

                // If we've gotten this far, we can assume that logs is non-empty.
                // Recall logs is sorted in ascending order, so the last log is the "oldest" / "earliest"
                // log in the range.
                let last_log = logs.first().expect("Logs must be non-empty");
                // Update the last snapshot accordingly.
                self.last_indexed_snapshot = OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(last_log.0.sequence()),
                    at_block: last_log.1.block_number.try_into().expect("todo"),
                };
                // Position the current snapshot to the previous sequence.
                self.current_indexing_snapshot = self.last_indexed_snapshot.previous();
            }
            IndexMode::Block => {
                // If the first log we got is a gap since the last snapshot, or there are gaps
                // in the logs, rewind to the last snapshot.

                // We require no sequence gaps and to build upon the last snapshot.
                let expected_sequences = ((current_indexing_snapshot.sequence + 1)
                    .saturating_sub(logs.len() as u32)
                    ..(current_indexing_snapshot.sequence + 1))
                    .collect::<HashSet<_>>();
                if all_log_sequences != expected_sequences {
                    warn!(
                        all_log_sequences=?all_log_sequences.iter().sorted().collect::<Vec<_>>(),
                        expected_sequences=?expected_sequences.iter().sorted().collect::<Vec<_>>(),
                        expected_sequence_range=?range,
                        missing_expected_sequences=?expected_sequences.difference(&all_log_sequences).sorted().collect::<Vec<_>>(),
                        unexpected_sequences=?all_log_sequences.difference(&expected_sequences).sorted().collect::<Vec<_>>(),
                        ?logs,
                        ?current_indexing_snapshot,
                        last_indexed_snapshot=?self.last_indexed_snapshot,
                        "Log sequences don't exactly match the expected sequence range, rewinding to last snapshot",
                    );
                    // If there are any missing sequences, rewind to just before the last indexed snapshot.
                    self.current_indexing_snapshot = self.last_indexed_snapshot.previous();
                    return Ok(());
                }

                let logs_len: u32 = logs.len().try_into()?;
                self.current_indexing_snapshot =
                    if current_indexing_snapshot.sequence + 1 == logs_len {
                        // We indexed everything, including sequence 0!
                        // We're done.
                        None
                    } else {
                        Some(SequenceAwareSyncSnapshot {
                            sequence: current_indexing_snapshot.sequence.saturating_sub(logs_len),
                            at_block: *range.start(),
                        })
                    };

                // This means we indexed at least one log that builds on the last snapshot.
                // Recall logs is sorted in ascending order, so the last log is the "oldest" / "earliest"
                // log in the range.
                if let Some(first_log) = logs.first() {
                    // Update the last snapshot.
                    self.last_indexed_snapshot = OptionalSequenceAwareSyncSnapshot {
                        sequence: Some(first_log.0.sequence()),
                        at_block: first_log.1.block_number.try_into().expect("todo"),
                    };
                }
            }
        })
    }
}

#[cfg(test)]
mod test {
    use super::super::forward::test::*;
    use super::*;

    fn get_test_backward_sequence_aware_sync_cursor(
        mode: IndexMode,
        chunk_size: u32,
    ) -> BackwardSequenceAwareSyncCursor<MockSequencedData> {
        let db = Arc::new(MockHyperlaneSequenceIndexerStore {
            logs: vec![
                (MockSequencedData::new(100), log_meta_with_block(1000)),
                (MockSequencedData::new(101), log_meta_with_block(1001)),
                (MockSequencedData::new(102), log_meta_with_block(1002)),
            ],
        });

        BackwardSequenceAwareSyncCursor::new(chunk_size, db, 100, 1000, mode)
    }

    mod block_range {
        use super::*;

        const INDEX_MODE: IndexMode = IndexMode::Block;
        const CHUNK_SIZE: u32 = 100;

        async fn get_cursor() -> BackwardSequenceAwareSyncCursor<MockSequencedData> {
            let mut cursor = get_test_backward_sequence_aware_sync_cursor(INDEX_MODE, CHUNK_SIZE);
            // Fast forwarded to sequence 99, block 1000
            cursor.fast_forward().await.unwrap();

            cursor
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_normal_indexing() {
            // Starts with current snapshot at sequence 99, block 1000
            let mut cursor = get_cursor().await;

            // We should have fast forwarded to sequence 99, block 1000
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(SequenceAwareSyncSnapshot {
                    sequence: 99,
                    at_block: 1000,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(100),
                    at_block: 1000,
                }
            );

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
                        (MockSequencedData::new(97), log_meta_with_block(970)),
                        (MockSequencedData::new(98), log_meta_with_block(980)),
                        (MockSequencedData::new(99), log_meta_with_block(990)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the previous sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(SequenceAwareSyncSnapshot {
                    sequence: 96,
                    at_block: 900,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(97),
                    at_block: 970,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_multiple_ranges() {
            // Starts with current snapshot at sequence 99, block 1000
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
                Some(SequenceAwareSyncSnapshot {
                    sequence: 99,
                    at_block: 900,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
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
                        (MockSequencedData::new(96), log_meta_with_block(850)),
                        (MockSequencedData::new(97), log_meta_with_block(860)),
                        (MockSequencedData::new(98), log_meta_with_block(870)),
                        (MockSequencedData::new(99), log_meta_with_block(880)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the previous sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(SequenceAwareSyncSnapshot {
                    sequence: 95,
                    at_block: 800,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(96),
                    at_block: 850,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_rewinds_for_sequence_gap() {
            // Starts with current snapshot at sequence 99, block 1000
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
                Some(SequenceAwareSyncSnapshot {
                    sequence: 99,
                    at_block: 900,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(100),
                    at_block: 1000,
                }
            );

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 800..=900;
            assert_eq!(range, expected_range);

            // Update the cursor with some found logs, but they don't build upon the last snapshot!
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(96), log_meta_with_block(850)),
                        (MockSequencedData::new(97), log_meta_with_block(860)),
                        (MockSequencedData::new(98), log_meta_with_block(870)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor rewound to just prior to the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(SequenceAwareSyncSnapshot {
                    sequence: 99,
                    at_block: 1000,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(100),
                    at_block: 1000,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_handles_unexpected_logs() {
            // Starts with current snapshot at sequence 99, block 1000
            let mut cursor = get_cursor().await;

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 900..=1000;
            assert_eq!(range, expected_range);

            // Update the cursor with some paritally bogus logs:
            // - Two logs of sequence 99, i.e. duplicated
            // - A log at sequence 100, which was already indexed and should be ignored
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(99), log_meta_with_block(990)),
                        (MockSequencedData::new(99), log_meta_with_block(990)),
                        (MockSequencedData::new(100), log_meta_with_block(1000)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the previous sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(SequenceAwareSyncSnapshot {
                    sequence: 98,
                    at_block: 900,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(99),
                    at_block: 990,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_stops_after_indexing_sequence_0() {
            // Starts with current snapshot at sequence 99, block 1000
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
                                MockSequencedData::new(i),
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
                OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(0),
                    at_block: 900,
                }
            );

            // Expect the range to be None
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);
        }
    }

    mod sequence_range {
        use super::*;

        const INDEX_MODE: IndexMode = IndexMode::Sequence;
        const CHUNK_SIZE: u32 = 5;

        async fn get_cursor() -> BackwardSequenceAwareSyncCursor<MockSequencedData> {
            let mut cursor = get_test_backward_sequence_aware_sync_cursor(INDEX_MODE, CHUNK_SIZE);
            // Fast forwarded to sequence 99, block 1000
            cursor.fast_forward().await.unwrap();

            cursor
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_normal_indexing() {
            // Starts with current snapshot at sequence 99, block 1000
            let mut cursor = get_cursor().await;

            // We should have fast forwarded to sequence 99, block 1000
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(SequenceAwareSyncSnapshot {
                    sequence: 99,
                    at_block: 1000,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
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

            // Update the cursor with some found logs.
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(94), log_meta_with_block(940)),
                        (MockSequencedData::new(95), log_meta_with_block(950)),
                        (MockSequencedData::new(96), log_meta_with_block(960)),
                        (MockSequencedData::new(97), log_meta_with_block(970)),
                        (MockSequencedData::new(98), log_meta_with_block(980)),
                        (MockSequencedData::new(99), log_meta_with_block(990)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have moved to the previous sequence and updated the last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(SequenceAwareSyncSnapshot {
                    sequence: 93,
                    at_block: 940,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(94),
                    at_block: 940,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_rewinds_if_updated_with_no_logs() {
            // Starts with current snapshot at sequence 99, block 1000
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
                Some(SequenceAwareSyncSnapshot {
                    sequence: 99,
                    at_block: 1000,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
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

            // Expect the range to be:
            // (current - chunk_size, current)
            let range = cursor.get_next_range().await.unwrap().unwrap();
            let expected_range = 94..=99;
            assert_eq!(range, expected_range);

            // Update the cursor with a gap (missing sequence 97)
            cursor
                .update(
                    vec![
                        (MockSequencedData::new(94), log_meta_with_block(940)),
                        (MockSequencedData::new(95), log_meta_with_block(950)),
                        (MockSequencedData::new(96), log_meta_with_block(960)),
                        (MockSequencedData::new(98), log_meta_with_block(980)),
                        (MockSequencedData::new(99), log_meta_with_block(990)),
                    ],
                    expected_range,
                )
                .await
                .unwrap();

            // Expect the cursor to have "rewound", i.e. no changes to the current indexing snapshot or last indexed snapshot.
            assert_eq!(
                cursor.current_indexing_snapshot,
                Some(SequenceAwareSyncSnapshot {
                    sequence: 99,
                    at_block: 1000,
                })
            );
            assert_eq!(
                cursor.last_indexed_snapshot,
                OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(100),
                    at_block: 1000,
                }
            );
        }

        #[tracing_test::traced_test]
        #[tokio::test]
        async fn test_stops_after_indexing_sequence_0() {
            // Starts with current snapshot at sequence 99, block 1000
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
                    (0..=99)
                        .map(|i| {
                            (
                                MockSequencedData::new(i),
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
                OptionalSequenceAwareSyncSnapshot {
                    sequence: Some(0),
                    at_block: 900,
                }
            );

            // Expect the range to be None
            let range = cursor.get_next_range().await.unwrap();
            assert_eq!(range, None);
        }
    }
}
