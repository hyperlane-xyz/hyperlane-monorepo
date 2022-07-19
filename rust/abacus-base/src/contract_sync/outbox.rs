use std::cmp::min;
use std::time::Duration;

use tokio::time::sleep;
use tracing::{debug, info, info_span, warn};
use tracing::{instrument::Instrumented, Instrument};

use abacus_core::{chain_from_domain, CommittedMessage, ListValidity, OutboxIndexer};

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
            .with_label_values(&[MESSAGES_LABEL, &self.chain_name]);

        let stored_messages = self
            .metrics
            .stored_events
            .with_label_values(&[MESSAGES_LABEL, &self.chain_name]);

        let missed_messages = self
            .metrics
            .missed_events
            .with_label_values(&[MESSAGES_LABEL, &self.chain_name]);

        let message_leaf_index = self.metrics.message_leaf_index.clone();
        let chain_name = self.chain_name.clone();

        let config_from = self.index_settings.from();
        let chunk_size = self.index_settings.chunk_size();

        // Indexes messages by fetching messages in ranges of blocks.
        // We've observed occasional flakiness with providers where some events in
        // a range will be missing. The leading theories are:
        // 1. The provider is just flaky and sometimes misses events :(
        // 2. For outbox chains with low finality times, it's possible that when
        //    we query the RPC provider for the latest finalized block number,
        //    we're returned a block number T. However when we attempt to index a range
        //    where the `to` block is T, the `eth_getLogs` RPC is load balanced by the
        //    provider to a different node whose latest known block is some block T' < T.
        //    The `eth_getLogs` RPC implementations seem to happily accept `to` blocks that
        //    exceed the latest known block, so it's possible that in our indexer we think
        //    that we've indexed up to block T but we've only *actually* indexed up to block T'.
        //
        // It's easy to determine if a provider has skipped any message events by
        // looking at the indices of each message and ensuring that we've indexed a valid
        // continuatioin of messages from index 0.
        // There are two classes of invalid continuations:
        // 1. The latest previously indexed message index is M that was found in a previously
        //    indexed block range. A new block range [A,B] is indexed, returning a list of messages.
        //    The lowest message index in that list is `M + 1`, but there are some missing messages
        //    indices in the list. This is likely a flaky provider, and we can simply re-index the
        //    range [A,B] hoping that the provider will soon return a correct list.
        // 2. The latest previously indexed message index is M that was found in a previously
        //    indexed block range, [A,B]. A new block range [C,D] is indexed, returning a list of
        //    messages. However, the lowest message index in that list is M' where M' > M + 1,
        //    indicating either a simple gap from a flaky provider as explained in (1), or that
        //    there was an issue when the prior block range [A,B] was indexed, where the provider
        //    didn't provide some messages with indices > M that did occur in the [A,B] range.
        //    We can handle this by re-indexing starting from block A.
        //    Note this means we only handle this case upon observing messages in some range [C,D]
        //    that indicate a previously indexed range may have missed some messages.
        tokio::spawn(async move {
            let mut from = db
                .retrieve_latest_valid_message_range_start_block()
                .map_or_else(|| config_from, |h| h + 1);

            let mut last_valid_range_start_block = from;

            info!(from = from, "[Messages]: resuming indexer from latest valid message range start block");

            loop {
                indexed_height.set(from as i64);

                // Only index blocks considered final
                let tip = indexer.get_finalized_block_number().await?;
                if tip <= from {
                    // TODO: Make this configurable
                    // Sleep if caught up to tip
                    sleep(Duration::from_secs(1)).await;
                    continue;
                }

                // Index the chunk_size, or until the tip if the chunk end block would exceed the tip.
                let to = min(tip, from + chunk_size);

                let mut sorted_messages = indexer.fetch_sorted_messages(from, to).await?;

                info!(
                    from = from,
                    to = to,
                    message_count = sorted_messages.len(),
                    "[Messages]: indexed block heights {from}...{to}"
                );

                // Get the latest known leaf index. All messages whose indices are <= this index
                // have been stored in the DB.
                let last_leaf_index: OptLatestLeafIndex = db.retrieve_latest_leaf_index()?.into();

                // Filter out any messages that have already been successfully indexed and stored.
                // This is necessary if we're re-indexing blocks in hope of finding missing messages.
                if let Some(min_index) = last_leaf_index.as_ref() {
                    sorted_messages = sorted_messages.into_iter().filter(|m| m.leaf_index > *min_index).collect();
                }

                debug!(
                    from = from,
                    to = to,
                    message_count = sorted_messages.len(),
                    "[Messages]: filtered any messages already indexed"
                );

                // Continue if no messages found.
                // We don't update last_valid_range_start_block because we cannot extrapolate
                // if the range was correctly indexed if there are no messages to observe their
                // indices.
                if sorted_messages.is_empty() {
                    from = to + 1;
                    continue;
                }

                // Ensure the sorted messages are a valid continution of last_leaf_index
                match &last_leaf_index.valid_continuation(&sorted_messages) {
                    ListValidity::Valid => {
                        // Store messages
                        let max_leaf_index_of_batch = db.store_messages(&sorted_messages)?;

                        // Report amount of messages stored into db
                        stored_messages.add(sorted_messages.len().try_into()?);

                        // Report latest leaf index to gauge by dst
                        for raw_msg in sorted_messages.iter() {
                            let dst = CommittedMessage::try_from(raw_msg)
                                .ok()
                                .and_then(|msg| chain_from_domain(msg.message.destination))
                                .unwrap_or("unknown");
                            message_leaf_index
                                .with_label_values(&["dispatch", &chain_name, dst])
                                .set(max_leaf_index_of_batch as i64);
                        }

                        // Update the start block of the range.
                        db.store_latest_valid_message_range_start_block(from)?;
                        last_valid_range_start_block = from;

                        // Move forward to the next height
                        from = to + 1;
                    },
                    // The index of the first message in sorted_messages is not the last_leaf_index + 1.
                    ListValidity::InvalidContinuation => {
                        missed_messages.inc();

                        warn!(
                            last_leaf_index = ?last_leaf_index,
                            start_block = from,
                            end_block = to,
                            last_valid_range_start_block,
                            "[Messages]: Found invalid continuation in range. Re-indexing from the start block of the last successful range.",
                        );

                        from = last_valid_range_start_block;
                    },
                    ListValidity::ContainsGaps => {
                        missed_messages.inc();

                        warn!(
                            last_leaf_index = ?last_leaf_index,
                            start_block = from,
                            end_block = to,
                            "[Messages]: Found gaps in the messages in range, re-indexing the same range.",
                        );
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
    use std::sync::Arc;

    use ethers::core::types::H256;
    use mockall::*;

    use abacus_core::{db::AbacusDB, AbacusMessage, Encode, RawCommittedMessage};
    use abacus_test::mocks::indexer::MockAbacusIndexer;
    use abacus_test::test_utils;

    use crate::ContractSync;
    use crate::{settings::IndexSettings, ContractSyncMetrics, CoreMetrics};

    use super::*;

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
