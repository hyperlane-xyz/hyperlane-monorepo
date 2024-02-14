use std::{
    cmp::Ordering, collections::HashSet, fmt::Debug, ops::RangeInclusive, sync::Arc, time::Duration,
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractSyncCursorNew, CursorAction,
    HyperlaneSequenceIndexerStore, IndexMode, LatestSequence, LogMeta, Sequenced,
};
use itertools::Itertools;
use tracing::{debug, warn};

use super::SequenceAwareSyncSnapshot;

/// A sequence-aware cursor that syncs forwards in perpetuity.
#[derive(Debug, new)]
pub(crate) struct BackwardSequenceAwareSyncCursorNew<T> {
    chunk_size: u32,
    db: Arc<dyn HyperlaneSequenceIndexerStore<T>>,
    last_indexed_snapshot: SequenceAwareSyncSnapshot,
    current_indexing_snapshot: SequenceAwareSyncSnapshot,
    index_mode: IndexMode,
    synced: bool,
}

impl<T: Sequenced> BackwardSequenceAwareSyncCursorNew<T> {
    async fn get_next_range(&mut self) -> ChainResult<Option<RangeInclusive<u32>>> {
        if self.synced {
            return Ok(None);
        }

        // TODO consider the possibility that we'll re-query for things the DB is already aware of.

        Ok(match &self.index_mode {
            IndexMode::Block => {
                // Query the block range ending at the current_indexing_snapshot's at_block.
                Some(
                    self.current_indexing_snapshot
                        .at_block
                        .saturating_sub(self.chunk_size)
                        ..=self.current_indexing_snapshot.at_block,
                )
            }
            IndexMode::Sequence => {
                // Query the sequence range ending at the current_indexing_snapshot's sequence.
                Some(
                    self.current_indexing_snapshot
                        .sequence
                        .saturating_sub(self.chunk_size)
                        ..=self.current_indexing_snapshot.sequence,
                )
            }
        })
    }
}

#[async_trait]
impl<T: Sequenced + Debug> ContractSyncCursorNew<T> for BackwardSequenceAwareSyncCursorNew<T> {
    async fn fast_forward(&mut self) -> ChainResult<()> {
        if self.synced {
            return Ok(());
        }

        // TODO consider indexing start range too?
        if self.last_indexed_snapshot.sequence == 0 || self.last_indexed_snapshot.at_block == 0 {
            self.synced = true;
            return Ok(());
        }

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
                self.last_indexed_snapshot = SequenceAwareSyncSnapshot {
                    sequence: self.current_indexing_snapshot.sequence,
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

        Ok(())
    }

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

        // Remove any duplicates, filter out any logs preceding our current snapshot, and sort.
        let logs = logs
            .into_iter()
            .dedup_by(|(log_a, _), (log_b, _)| log_a.sequence() == log_b.sequence())
            // TODO: note that this is <= and the forward is >=, may be an opportunity for
            // code de-dupe beacuse of this
            .filter(|(log, _)| log.sequence() <= self.current_indexing_snapshot.sequence)
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
                        ?all_log_sequences,
                        ?expected_sequences,
                        expected_sequence_range=?range,
                        missing_expected_sequences=?expected_sequences.difference(&all_log_sequences).collect::<Vec<_>>(),
                        unexpected_sequences=?all_log_sequences.difference(&expected_sequences).collect::<Vec<_>>(),
                        ?logs,
                        current_indexing_snapshot=?self.current_indexing_snapshot,
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
                let last_log = logs.last().expect("Logs must be non-empty");
                // Update the last snapshot accordingly.
                self.last_indexed_snapshot = SequenceAwareSyncSnapshot {
                    sequence: last_log.0.sequence(),
                    at_block: last_log.1.block_number.try_into().expect("todo"),
                };
                // Position the current snapshot to the previous sequence.
                self.current_indexing_snapshot = self.last_indexed_snapshot.previous();
            }
            IndexMode::Block => {
                // If the first log we got is a gap since the last snapshot, or there are gaps
                // in the logs, rewind to the last snapshot.

                // We require no sequence gaps and to build upon the last snapshot.
                let expected_sequences = (self
                    .current_indexing_snapshot
                    .sequence
                    .saturating_sub(logs.len() as u32)
                    ..(self.current_indexing_snapshot.sequence))
                    .collect::<HashSet<_>>();
                if all_log_sequences != expected_sequences {
                    warn!(
                        ?all_log_sequences,
                        ?expected_sequences,
                        expected_sequence_range=?range,
                        missing_expected_sequences=?expected_sequences.difference(&all_log_sequences).collect::<Vec<_>>(),
                        unexpected_sequences=?all_log_sequences.difference(&expected_sequences).collect::<Vec<_>>(),
                        ?logs,
                        current_indexing_snapshot=?self.current_indexing_snapshot,
                        last_indexed_snapshot=?self.last_indexed_snapshot,
                        "Log sequences don't exactly match the expected sequence range, rewinding to last snapshot",
                    );
                    // If there are any missing sequences, rewind to just before the last indexed snapshot.
                    self.current_indexing_snapshot = self.last_indexed_snapshot.previous();
                    return Ok(());
                }

                self.current_indexing_snapshot = SequenceAwareSyncSnapshot {
                    sequence: self
                        .current_indexing_snapshot
                        .sequence
                        .saturating_sub(logs.len() as u32),
                    at_block: *range.start(),
                };

                // This means we indexed at least one log that builds on the last snapshot.
                // Recall logs is sorted in ascending order, so the last log is the "oldest" / "earliest"
                // log in the range.
                if let Some(first_log) = logs.first() {
                    // Update the last snapshot.
                    self.last_indexed_snapshot = SequenceAwareSyncSnapshot {
                        sequence: first_log.0.sequence(),
                        at_block: first_log.1.block_number.try_into().expect("todo"),
                    };
                }
            }
        })
    }
}

// #[cfg(test)]
// mod test {
//     use hyperlane_core::HyperlaneLogStore;

//     use super::*;

//     #[derive(Debug, Clone)]
//     struct MockLatestSequenceQuerier {
//         latest_sequence_count: Option<u32>,
//         tip: u32,
//     }

//     #[async_trait]
//     impl LatestSequence for MockLatestSequenceQuerier {
//         async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
//             Ok((self.latest_sequence_count, self.tip))
//         }
//     }

//     #[derive(Debug, Clone)]
//     struct MockHyperlaneSequenceIndexerStore<T> {
//         logs: Vec<(T, LogMeta)>,
//     }

//     #[async_trait]
//     impl<T: Sequenced + Debug> HyperlaneLogStore<T> for MockHyperlaneSequenceIndexerStore<T> {
//         async fn store_logs(&self, logs: &[(T, LogMeta)]) -> eyre::Result<u32> {
//             Ok(logs.len() as u32)
//         }
//     }

//     #[async_trait]
//     impl<T: Sequenced + Debug + Clone> HyperlaneSequenceIndexerStore<T>
//         for MockHyperlaneSequenceIndexerStore<T>
//     {
//         async fn retrieve_by_sequence(&self, sequence: u32) -> eyre::Result<Option<T>> {
//             Ok(self
//                 .logs
//                 .iter()
//                 .find(|(log, _)| log.sequence() == sequence)
//                 .map(|(log, _)| log.clone()))
//         }

//         async fn retrieve_log_block_number(&self, sequence: u32) -> eyre::Result<Option<u64>> {
//             Ok(self
//                 .logs
//                 .iter()
//                 .find(|(log, _)| log.sequence() == sequence)
//                 .map(|(_, meta)| meta.block_number))
//         }
//     }

//     #[derive(Debug, Clone, new)]
//     struct MockSequencedData {
//         sequence: u32,
//     }

//     impl Sequenced for MockSequencedData {
//         fn sequence(&self) -> u32 {
//             self.sequence
//         }
//     }

//     fn log_meta_with_block(block_number: u64) -> LogMeta {
//         LogMeta {
//             address: Default::default(),
//             block_number,
//             block_hash: Default::default(),
//             transaction_id: Default::default(),
//             transaction_index: 0,
//             log_index: Default::default(),
//         }
//     }

//     const CHUNK_SIZE: u32 = 100;

//     fn get_test_forward_sequence_aware_sync_cursor(
//     ) -> BackwardSequenceAwareSyncCursorNew<MockSequencedData> {
//         let latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
//             latest_sequence_count: Some(5),
//             tip: 100,
//         });

//         let db = Arc::new(MockHyperlaneSequenceIndexerStore {
//             logs: vec![
//                 (MockSequencedData::new(0), log_meta_with_block(50)),
//                 (MockSequencedData::new(1), log_meta_with_block(60)),
//                 (MockSequencedData::new(2), log_meta_with_block(70)),
//                 (MockSequencedData::new(3), log_meta_with_block(80)),
//                 (MockSequencedData::new(4), log_meta_with_block(90)),
//             ],
//         });

//         // We're starting at sequence 2, block 70.
//         let last_indexed_snapshot = SequenceAwareSyncSnapshot {
//             sequence: 2,
//             at_block: 70,
//         };

//         BackwardSequenceAwareSyncCursorNew::new(
//             CHUNK_SIZE,
//             latest_sequence_querier,
//             db,
//             last_indexed_snapshot.clone(),
//             last_indexed_snapshot.clone(),
//             None,
//             IndexMode::Block,
//         )
//     }

//     /// Tests successful fast forwarding & indexing where all ranges return logs.
//     #[tracing_test::traced_test]
//     #[tokio::test]
//     async fn test_forward_sequence_aware_sync_cursor_block_range_normal_indexing() {
//         let mut cursor = get_test_forward_sequence_aware_sync_cursor();

//         // Fast forward
//         cursor.fast_forward().await.unwrap();

//         // We should have fast forwarded to sequence 5, block 90
//         assert_eq!(
//             cursor.current_indexing_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 5,
//                 at_block: 90,
//             }
//         );

//         // As the latest sequence count is 5 and the current indexing snapshot is sequence 5, we should
//         // expect no range to index.
//         let range = cursor.get_next_range().await.unwrap();
//         assert_eq!(range, None);

//         // Update the tip, expect to still not index anything.
//         cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
//             latest_sequence_count: Some(5),
//             tip: 110,
//         });
//         let range = cursor.get_next_range().await.unwrap();
//         assert_eq!(range, None);

//         // Update the latest sequence count to 6, now we expect to index.
//         cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
//             latest_sequence_count: Some(6),
//             tip: 120,
//         });

//         // Expect the range to be:
//         // (last polled block where the sequence had already been indexed, tip)
//         let range = cursor.get_next_range().await.unwrap().unwrap();
//         let expected_range = 110..=120;
//         assert_eq!(range, expected_range);

//         // Expect the target snapshot to be set to the latest sequence and tip.
//         assert_eq!(
//             cursor.target_snapshot,
//             Some(SequenceAwareSyncSnapshot {
//                 sequence: 5,
//                 at_block: 120,
//             })
//         );

//         // Getting the range again without updating the cursor should yield the same range.
//         let range = cursor.get_next_range().await.unwrap().unwrap();
//         assert_eq!(range, expected_range);

//         // Update the cursor with the found log.
//         cursor
//             .update(
//                 vec![(MockSequencedData::new(5), log_meta_with_block(115))],
//                 expected_range,
//             )
//             .await
//             .unwrap();

//         // Expect the cursor to have moved to the next sequence and updated the last indexed snapshot.
//         assert_eq!(
//             cursor.current_indexing_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 6,
//                 at_block: 120,
//             }
//         );
//         assert_eq!(
//             cursor.last_indexed_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 5,
//                 at_block: 115,
//             }
//         );

//         // And now we should get no range to index.
//         let range = cursor.get_next_range().await.unwrap();
//         assert_eq!(range, None);
//     }

//     // Tests when the cursor is so behind the tip that it'll need to index multiple ranges (due to the
//     // chunk size) to catch up.
//     #[tracing_test::traced_test]
//     #[tokio::test]
//     async fn test_forward_sequence_aware_sync_cursor_block_range_multiple_ranges_till_target() {
//         let mut cursor = get_test_forward_sequence_aware_sync_cursor();
//         // Fast forwarded to sequence 5, block 90
//         cursor.fast_forward().await.unwrap();

//         // Pretend like the tip is 200, and a message occurred at block 195.

//         // Increase the latest sequence count, and with a tip that exceeds the chunk size.
//         cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
//             latest_sequence_count: Some(6),
//             tip: 200,
//         });

//         // Expect the range to be:
//         // (start, start + chunk_size)
//         let range = cursor.get_next_range().await.unwrap().unwrap();
//         let expected_range = 90..=190;
//         assert_eq!(range, expected_range);

//         // Update the cursor. Update with no logs, because the log happened in block 195.
//         cursor.update(vec![], expected_range).await.unwrap();

//         // Expect the cursor to have moved the current indexing snapshot's block number (but not sequence),
//         // and made no changes to the last indexed snapshot.
//         assert_eq!(
//             cursor.current_indexing_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 5,
//                 at_block: 190,
//             }
//         );
//         assert_eq!(
//             cursor.last_indexed_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 4,
//                 at_block: 90,
//             }
//         );

//         // Expect the range to be:
//         // (start, tip)
//         let range = cursor.get_next_range().await.unwrap().unwrap();
//         let expected_range = 190..=200;
//         assert_eq!(range, expected_range);

//         // Update the cursor with the found log.
//         cursor
//             .update(
//                 vec![(MockSequencedData::new(5), log_meta_with_block(195))],
//                 expected_range,
//             )
//             .await
//             .unwrap();

//         // Expect the current indexing snapshot to have moved to the next sequence and updated the last indexed snapshot.
//         assert_eq!(
//             cursor.current_indexing_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 6,
//                 at_block: 200,
//             }
//         );
//         assert_eq!(
//             cursor.last_indexed_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 5,
//                 at_block: 195,
//             }
//         );

//         // And now we should get no range to index.
//         let range = cursor.get_next_range().await.unwrap();
//         assert_eq!(range, None);
//     }

//     /// Tests when the cursor is so behind the tip that it'll need to index multiple ranges, but by the time
//     /// it gets to the target snapshot, it realizes it missed a log and needs to rewind.
//     #[tracing_test::traced_test]
//     #[tokio::test]
//     async fn test_forward_sequence_aware_sync_cursor_block_range_rewinds_for_missed_target_sequence(
//     ) {
//         let mut cursor = get_test_forward_sequence_aware_sync_cursor();
//         // Fast forwarded to sequence 5, block 90
//         cursor.fast_forward().await.unwrap();

//         // Pretend like the tip is 200, and a message occurred at block 195, but we somehow miss it.

//         cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
//             latest_sequence_count: Some(6),
//             tip: 200,
//         });

//         // Expect the range to be:
//         // (start, start + chunk_size)
//         let range = cursor.get_next_range().await.unwrap().unwrap();
//         let expected_range = 90..=190;
//         assert_eq!(range, expected_range);

//         // Update the cursor with no found logs.
//         cursor.update(vec![], expected_range).await.unwrap();

//         // Expect the cursor to have moved the current indexing snapshot's block number (but not sequence),
//         // and made no changes to the last indexed snapshot.
//         assert_eq!(
//             cursor.current_indexing_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 5,
//                 at_block: 190,
//             }
//         );
//         assert_eq!(
//             cursor.last_indexed_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 4,
//                 at_block: 90,
//             }
//         );

//         // Expect the range to be:
//         // (start, tip)
//         let range = cursor.get_next_range().await.unwrap().unwrap();
//         let expected_range = 190..=200;
//         assert_eq!(range, expected_range);

//         // Update the cursor with no found logs.
//         cursor.update(vec![], expected_range).await.unwrap();

//         // Expect a rewind to occur back to the last indexed snapshot's block number.
//         assert_eq!(
//             cursor.current_indexing_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 5,
//                 at_block: 90,
//             }
//         );
//         assert_eq!(
//             cursor.last_indexed_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 4,
//                 at_block: 90,
//             }
//         );
//     }

//     /// Tests when the cursor is so behind the tip that it'll need to index multiple ranges. It successfully
//     /// finds a log in the second range, but missed log in the first range, showing a gap. It should rewind to the
//     /// last indexed snapshot.
//     #[tracing_test::traced_test]
//     #[tokio::test]
//     async fn test_forward_sequence_aware_sync_cursor_block_range_rewinds_for_sequence_gap() {
//         let mut cursor = get_test_forward_sequence_aware_sync_cursor();
//         // Fast forwarded to sequence 5, block 90
//         cursor.fast_forward().await.unwrap();

//         // Pretend like the tip is 200, a message occurred at block 150 that's missed,
//         // and another message at block 195 is found.

//         cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
//             // 3 new messages since we last indexed have come in!
//             latest_sequence_count: Some(7),
//             tip: 200,
//         });

//         // Expect the range to be:
//         // (start, start + chunk_size)
//         let range = cursor.get_next_range().await.unwrap().unwrap();
//         let expected_range = 90..=190;
//         assert_eq!(range, expected_range);

//         // Update the cursor with no found logs. We should've found one here though!
//         cursor.update(vec![], expected_range).await.unwrap();

//         // Expect the cursor to have moved the current indexing snapshot's block number (but not sequence),
//         // and made no changes to the last indexed snapshot.
//         assert_eq!(
//             cursor.current_indexing_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 5,
//                 at_block: 190,
//             }
//         );
//         assert_eq!(
//             cursor.last_indexed_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 4,
//                 at_block: 90,
//             }
//         );

//         // Expect the range to be:
//         // (start, tip)
//         let range = cursor.get_next_range().await.unwrap().unwrap();
//         let expected_range = 190..=200;
//         assert_eq!(range, expected_range);

//         // Update the cursor with no found logs.
//         cursor
//             .update(
//                 vec![
//                     // There's a gap - we missed a log at sequence 5.
//                     (MockSequencedData::new(6), log_meta_with_block(195)),
//                 ],
//                 expected_range,
//             )
//             .await
//             .unwrap();

//         // Expect a rewind to occur back to the last indexed snapshot's block number.
//         assert_eq!(
//             cursor.current_indexing_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 5,
//                 at_block: 90,
//             }
//         );
//         assert_eq!(
//             cursor.last_indexed_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 4,
//                 at_block: 90,
//             }
//         );
//     }

//     /// Tests when the cursor is so behind the tip that it'll need to index multiple ranges, but by the time
//     /// it gets to the target snapshot, it realizes it missed a log and needs to rewind.
//     #[tracing_test::traced_test]
//     #[tokio::test]
//     async fn test_forward_sequence_aware_sync_cursor_block_range_handles_unexpected_logs() {
//         let mut cursor = get_test_forward_sequence_aware_sync_cursor();
//         // Fast forwarded to sequence 5, block 90
//         cursor.fast_forward().await.unwrap();

//         // Pretend like the tip is 100, and a message occurred at block 95.

//         cursor.latest_sequence_querier = Arc::new(MockLatestSequenceQuerier {
//             latest_sequence_count: Some(6),
//             tip: 100,
//         });

//         // Expect the range to be:
//         // (start, start + chunk_size)
//         let range = cursor.get_next_range().await.unwrap().unwrap();
//         let expected_range = 90..=100;
//         assert_eq!(range, expected_range);

//         // Update the cursor with bogus logs:
//         // - A log at sequence 4, which was already indexed and should be ignored
//         // - Two logs of sequence 5, i.e. duplicated
//         // - A log at sequence 6, which is unexpected, but tolerated nonetheless
//         cursor
//             .update(
//                 vec![
//                     (MockSequencedData::new(4), log_meta_with_block(90)),
//                     (MockSequencedData::new(5), log_meta_with_block(95)),
//                     (MockSequencedData::new(5), log_meta_with_block(95)),
//                     (MockSequencedData::new(6), log_meta_with_block(100)),
//                 ],
//                 expected_range,
//             )
//             .await
//             .unwrap();

//         // Expect the cursor to have moved to the next sequence and updated the last indexed snapshot.
//         assert_eq!(
//             cursor.current_indexing_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 7,
//                 at_block: 100,
//             }
//         );
//         assert_eq!(
//             cursor.last_indexed_snapshot,
//             SequenceAwareSyncSnapshot {
//                 sequence: 6,
//                 at_block: 100,
//             }
//         );
//     }
// }
