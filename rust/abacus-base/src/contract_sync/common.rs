// TODO: Reapply tip buffer
// TODO: Reapply metrics

use abacus_core::AbacusCommonIndexer;

use tokio::time::sleep;
use tracing::info_span;
use tracing::{instrument::Instrumented, Instrument};

use std::time::Duration;

use crate::ContractSync;

impl<I> ContractSync<I>
where
    I: AbacusCommonIndexer + 'static,
{
    /// TODO: Not implemented
    pub fn sync_checkpoints(&self) -> Instrumented<tokio::task::JoinHandle<eyre::Result<()>>> {
        let span = info_span!("CheckpointContractSync");

        tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(1)).await;
            }
        })
        .instrument(span)
    }
}

#[cfg(test)]
mod test {
    use abacus_test::mocks::indexer::MockAbacusIndexer;
    use mockall::*;

    use std::sync::Arc;

    use ethers::core::types::H256;

    use abacus_core::{db::AbacusDB, Checkpoint, CheckpointMeta, CheckpointWithMeta};
    use abacus_test::test_utils;

    use super::*;
    use crate::{
        contract_sync::ContractSync, settings::IndexSettings, ContractSyncMetrics, CoreMetrics,
    };

    #[tokio::test]
    #[ignore]
    // Checkpoints are not indexed at the moment, remove #[ignore] when checkpoint
    // indexing is implemented to use this test.
    async fn handles_missing_rpc_checkpoints() {
        test_utils::run_test_db(|db| async move {
            let first_root = H256::from([0; 32]);
            let second_root = H256::from([1; 32]);
            let third_root = H256::from([2; 32]);
            let fourth_root = H256::from([3; 32]);
            let fifth_root = H256::from([4; 32]);

            let first_checkpoint = Checkpoint {
                outbox_domain: 1,
                root: first_root,
                index: 1,
            };

            let second_checkpoint = Checkpoint {
                outbox_domain: 1,
                root: second_root,
                index: 2,
            };

            let third_checkpoint = Checkpoint {
                outbox_domain: 1,
                root: third_root,
                index: 3,
            };

            let fourth_checkpoint = Checkpoint {
                outbox_domain: 1,
                root: fourth_root,
                index: 4,
            };

            let fifth_checkpoint = Checkpoint {
                outbox_domain: 1,
                root: fifth_root,
                index: 5,
            };

            let mut mock_indexer = MockAbacusIndexer::new();
            {
                let mut seq = Sequence::new();

                let first_checkpoint_with_meta = CheckpointWithMeta {
                    checkpoint: first_checkpoint.clone(),
                    metadata: CheckpointMeta { block_number: 5 },
                };

                let second_checkpoint_with_meta = CheckpointWithMeta {
                    checkpoint: second_checkpoint.clone(),
                    metadata: CheckpointMeta { block_number: 15 },
                };
                let second_checkpoint_with_meta_clone = second_checkpoint_with_meta.clone();

                let third_checkpoint_with_meta = CheckpointWithMeta {
                    checkpoint: third_checkpoint.clone(),
                    metadata: CheckpointMeta { block_number: 15 },
                };

                let fourth_checkpoint_with_meta = CheckpointWithMeta {
                    checkpoint: fourth_checkpoint.clone(),
                    metadata: CheckpointMeta { block_number: 25 },
                };
                let fourth_checkpoint_with_meta_clone_1 = fourth_checkpoint_with_meta.clone();
                let fourth_checkpoint_with_meta_clone_2 = fourth_checkpoint_with_meta.clone();

                let fifth_checkpoint_with_meta = CheckpointWithMeta {
                    checkpoint: fifth_checkpoint.clone(),
                    metadata: CheckpointMeta { block_number: 55 },
                };
                let fifth_checkpoint_with_meta_clone_1 = fifth_checkpoint_with_meta.clone();
                let fifth_checkpoint_with_meta_clone_2 = fifth_checkpoint_with_meta.clone();
                let fifth_checkpoint_with_meta_clone_3 = fifth_checkpoint_with_meta.clone();

                // Return first checkpoint
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![first_checkpoint_with_meta]));

                // Return second checkpoint, misses third checkpoint
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![second_checkpoint_with_meta]));

                // --> miss fourth checkpoint
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Next block range is empty checkpoints
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // second --> return fifth checkpoint is invalid
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_checkpoint_with_meta]));

                // Indexer goes back and tries empty block range
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Indexer tries to move on to realized missing block range but
                // can't
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_checkpoint_with_meta_clone_1]));

                // Indexer goes back further and gets to the fourth checkpoint
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fourth_checkpoint_with_meta_clone_1]));

                // Indexer goes further for empty range
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Indexer goes back further and gets to the fifth checkpoint
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_checkpoint_with_meta_clone_2]));

                // Indexer goes back even further to find 2nd and 3rd checkpoint
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| {
                        Ok(vec![
                            second_checkpoint_with_meta_clone,
                            third_checkpoint_with_meta,
                        ])
                    });

                // Indexer goes forward and gets to the fourth checkpoint again
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fourth_checkpoint_with_meta_clone_2]));

                // Indexer goes further for empty range
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Indexer goes back further and gets to the fifth checkpoint
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_checkpoint_with_meta_clone_3]));

                // Return empty vec for remaining calls
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_checkpoints()
                    .return_once(move |_, _| Ok(vec![]));
            }

            let abacus_db = AbacusDB::new("outbox_1", db);

            let indexer = Arc::new(mock_indexer);
            let metrics = Arc::new(
                CoreMetrics::new("contract_sync_test", None, prometheus::Registry::new())
                    .expect("could not make metrics"),
            );

            let sync_metrics = ContractSyncMetrics::new(metrics);

            let contract_sync = ContractSync::new(
                "outbox_1".into(),
                abacus_db.clone(),
                indexer.clone(),
                IndexSettings {
                    from: Some("0".to_string()),
                    chunk: Some("10".to_string()),
                },
                sync_metrics,
            );

            let sync_task = contract_sync.sync_checkpoints();
            sleep(Duration::from_secs(3)).await;
            cancel_task!(sync_task);

            // Checkpoints indexing is not implemented at the moment.
            // This can be used when it's implemented in the future.

            // assert_eq!(
            //     abacus_db
            //         .checkpoint_by_previous_root(first_root)
            //         .expect("!db")
            //         .expect("!checkpoint"),
            //     first_checkpoint.clone()
            // );
            // assert_eq!(
            //     abacus_db
            //         .checkpoint_by_previous_root(second_root)
            //         .expect("!db")
            //         .expect("!checkpoint"),
            //     second_checkpoint.clone()
            // );
            // assert_eq!(
            //     abacus_db
            //         .checkpoint_by_previous_root(third_root)
            //         .expect("!db")
            //         .expect("!checkpoint"),
            //     third_checkpoint.clone()
            // );
            // assert_eq!(
            //     abacus_db
            //         .checkpoint_by_previous_root(fourth_root)
            //         .expect("!db")
            //         .expect("!checkpoint"),
            //     fourth_checkpoint.clone()
            // );

            // assert_eq!(
            //     abacus_db
            //         .checkpoint_by_previous_root(fifth_root)
            //         .expect("!db")
            //         .expect("!checkpoint"),
            //     fifth_checkpoint.clone()
            // );
        })
        .await
    }
}
