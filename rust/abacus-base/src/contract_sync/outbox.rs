use abacus_core::{ListValidity, OutboxIndexer};

use tokio::time::sleep;
use tracing::{info, info_span, warn};
use tracing::{instrument::Instrumented, Instrument};

use std::cmp::min;
use std::time::Duration;

use crate::{
    contract_sync::{last_message::OptLatestLeafIndex, schema::OutboxContractSyncDB},
    ContractSync,
};

const MESSAGES_LABEL: &str = "messages";

impl<I> ContractSync<I>
where
    I: OutboxIndexer + 'static,
{
    /// Sync outbox messages
    pub fn sync_outbox_messages(&self) -> Instrumented<tokio::task::JoinHandle<eyre::Result<()>>> {
        let span = info_span!("MessageContractSync");

        let db = self.db.clone();
        let indexer = self.indexer.clone();
        let indexed_height = self
            .metrics
            .indexed_height
            .clone()
            .with_label_values(&[MESSAGES_LABEL, &self.chain_name]);

        let stored_messages = self
            .metrics
            .stored_events
            .clone()
            .with_label_values(&[MESSAGES_LABEL, &self.chain_name]);

        let missed_messages = self
            .metrics
            .missed_events
            .clone()
            .with_label_values(&[MESSAGES_LABEL, &self.chain_name]);

        let message_leaf_index = self.metrics.message_leaf_index.clone().with_label_values(&[
            "dispatch",
            &self.chain_name,
            "unknown",
        ]);

        let config_from = self.index_settings.from();
        let chunk_size = self.index_settings.chunk_size();

        tokio::spawn(async move {
            let mut from = db
                .retrieve_message_latest_block_end()
                .map_or_else(|| config_from, |h| h + 1);

            let mut finding_missing = false;
            let mut realized_missing_start_block = 0;
            let mut realized_missing_end_block = 0;
            let mut exponential = 0;

            info!(from = from, "[Messages]: resuming indexer from {from}");

            // Set the metrics with the latest known leaf index
            if let Ok(Some(idx)) = db.retrieve_latest_leaf_index() {
                message_leaf_index.set(idx as i64);
            }

            loop {
                indexed_height.set(from as i64);

                // If we were searching for missing message and have reached
                // original missing start block, turn off finding_missing and
                // TRY to resume normal indexing
                if finding_missing && from >= realized_missing_start_block {
                    info!("Turning off finding_missing mode");
                    finding_missing = false;
                }

                // If we have passed the end block of the missing message, we
                // have found the message and can reset variables
                if from > realized_missing_end_block && realized_missing_end_block != 0 {
                    missed_messages.inc();

                    exponential = 0;
                    realized_missing_start_block = 0;
                    realized_missing_end_block = 0;
                }

                // Only index blocks considered final
                let tip = indexer.get_finalized_block_number().await?;
                if tip <= from {
                    // TODO: Make this configurable
                    // Sleep if caught up to tip
                    sleep(Duration::from_secs(1)).await;
                    continue;
                }

                let candidate = from + chunk_size;
                let to = min(tip, candidate);

                let sorted_messages = indexer.fetch_sorted_messages(from, to).await?;

                info!(
                    from = from,
                    to = to,
                    message_count = sorted_messages.len(),
                    "[Messages]: indexed block heights {from}...{to}"
                );

                // If no messages found, update last seen block and next height
                // and continue
                if sorted_messages.is_empty() {
                    db.store_message_latest_block_end(to)?;
                    from = to + 1;
                    continue;
                }

                // If messages found, check that list is valid
                let last_leaf_index: OptLatestLeafIndex = db.retrieve_latest_leaf_index()?.into();
                match &last_leaf_index.valid_continuation(&sorted_messages) {
                    ListValidity::Valid => {
                        // Store messages
                        let max_leaf_index_of_batch = db.store_messages(&sorted_messages)?;

                        // Report amount of messages stored into db
                        stored_messages.add(sorted_messages.len().try_into()?);

                        // Report latest leaf index to gauge
                        message_leaf_index.set(max_leaf_index_of_batch as i64);

                        // Move forward next height
                        db.store_message_latest_block_end(to)?;
                        from = to + 1;
                    }
                    ListValidity::Invalid => {
                        if finding_missing {
                            from = to + 1;
                        } else {
                            warn!(
                                last_leaf_index = ?last_leaf_index,
                                start_block = from,
                                end_block = to,
                                "[Messages]: RPC failed to find message(s) between blocks {from}...{to}. Last seen leaf index: {:?}. Activating finding_missing mode.",
                                last_leaf_index
                            );

                            // Turn on finding_missing mode
                            finding_missing = true;
                            realized_missing_start_block = from;
                            realized_missing_end_block = to;

                            from = realized_missing_start_block - (chunk_size * 2u32.pow(exponential as u32));
                            exponential += 1;
                        }
                    }
                    ListValidity::Empty => unreachable!("Tried to validate empty list of messages"),
                };
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

    use abacus_core::{db::AbacusDB, AbacusMessage, Encode, RawCommittedMessage};
    use abacus_test::test_utils;

    use super::*;
    use crate::ContractSync;
    use crate::{settings::IndexSettings, ContractSyncMetrics, CoreMetrics};

    #[tokio::test]
    async fn handles_missing_rpc_messages() {
        test_utils::run_test_db(|db| async move {
            // let first_root = H256::from([0; 32]);
            // let second_root = H256::from([1; 32]);
            // let third_root = H256::from([2; 32]);
            // let fourth_root = H256::from([2; 32]);

            let mut message_vec = vec![];
            AbacusMessage {
                origin: 1000,
                destination: 2000,
                sender: H256::from([10; 32]),
                recipient: H256::from([11; 32]),
                body: [10u8; 5].to_vec(),
            }
            .write_to(&mut message_vec)
            .expect("!write_to");

            let first_message = RawCommittedMessage {
                leaf_index: 0,
                message: message_vec.clone(),
            };

            let second_message = RawCommittedMessage {
                leaf_index: 1,
                message: message_vec.clone(),
            };
            let second_message_clone = second_message.clone();

            let third_message = RawCommittedMessage {
                leaf_index: 2,
                message: message_vec.clone(),
            };

            let fourth_message = RawCommittedMessage {
                leaf_index: 3,
                message: message_vec.clone(),
            };
            let fourth_message_clone_1 = fourth_message.clone();
            let fourth_message_clone_2 = fourth_message.clone();

            let fifth_message = RawCommittedMessage {
                leaf_index: 4,
                message: message_vec.clone(),
            };
            let fifth_message_clone_1 = fifth_message.clone();
            let fifth_message_clone_2 = fifth_message.clone();
            let fifth_message_clone_3 = fifth_message.clone();

            let mut mock_indexer = MockAbacusIndexer::new();
            {
                let mut seq = Sequence::new();

                // Return first message
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![first_message.clone()]));

                // Return second message, misses third message
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![second_message]));

                // misses the fourth
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // empty range
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // second --> fifth message seen as invalid
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_message]));

                // Indexer goes back and tries empty block range
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Indexer tries to move on to realized missing block range but
                // can't
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_message_clone_1]));

                // Indexer goes back further and gets to fourth message
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fourth_message_clone_1]));

                // Indexer gets empty range again
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Indexer gets fifth message again
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_message_clone_2]));

                // Indexer goes back even further and gets to message 2 and 3
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![second_message_clone, third_message]));

                // Return fourth message
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fourth_message_clone_2]));

                // Reindexes empty block range
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Return fifth message
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_message_clone_3]));

                // Return empty vec for remaining calls
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
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

            let sync_task = contract_sync.sync_outbox_messages();
            sleep(Duration::from_secs(3)).await;
            cancel_task!(sync_task);

            assert!(abacus_db.message_by_leaf_index(0).expect("!db").is_some());
            assert!(abacus_db.message_by_leaf_index(1).expect("!db").is_some());
            assert!(abacus_db.message_by_leaf_index(2).expect("!db").is_some());
            assert!(abacus_db.message_by_leaf_index(3).expect("!db").is_some());
            assert!(abacus_db.message_by_leaf_index(4).expect("!db").is_some());
        })
        .await
    }
}
