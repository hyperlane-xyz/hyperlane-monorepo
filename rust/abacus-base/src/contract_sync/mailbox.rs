use std::cmp::min;
use std::time::Duration;

use eyre::Result;
use tokio::time::sleep;
use tracing::{debug, info, info_span, warn};
use tracing::{instrument::Instrumented, Instrument};

use abacus_core::{name_from_domain_id, ListValidity, MailboxIndexer};

use crate::contract_sync::last_message::validate_message_continuity;
use crate::{contract_sync::schema::OutboxContractSyncDB, ContractSync};

const MESSAGES_LABEL: &str = "messages";

impl<I> ContractSync<I>
where
    I: MailboxIndexer + Clone + 'static,
{
    /// Sync dispatched messages
    pub fn sync_dispatched_messages(&self) -> Instrumented<tokio::task::JoinHandle<Result<()>>> {
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

        let message_nonce = self.metrics.message_nonce.clone();
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

        // It's easy to determine if a provider has skipped any message events by
        // looking at the indices of each message and ensuring that we've indexed a valid
        // continuation of messages.
        // There are two classes of invalid continuations:
        // 1. The latest previously indexed message index is M that was found in a previously
        //    indexed block range. A new block range [A,B] is indexed, returning a list of messages.
        //    The lowest message index in that list is `M + 1`, but there are some missing messages
        //    indices in the list. This is likely a flaky provider, and we can simply re-index the
        //    range [A,B] hoping that the provider will soon return a correct list.
        // 2. The latest previously indexed message index is M that was found in a previously
        //    indexed block range, [A,B]. A new block range [C,D] is indexed, returning a list of
        //    messages. However, the lowest message index in that list is M' where M' > M + 1.
        //    This missing messages could be anywhere in the range [A,D]:
        //    * It's possible there was an issue when the prior block range [A,B] was indexed, where
        //      the provider didn't provide some messages with indices > M that it should have.
        //    * It's possible that the range [B,C] that was presumed to be empty when it was indexed
        //      actually wasn't.
        //    * And it's possible that this was just a flaky gap, where there are messages in the [C,D]
        //      range that weren't returned for some reason.
        //    We can handle this by re-indexing starting from block A.
        //    Note this means we only handle this case upon observing messages in some range [C,D]
        //    that indicate a previously indexed range may have missed some messages.
        tokio::spawn(async move {
            let mut from = db
                .retrieve_latest_valid_message_range_start_block()
                .unwrap_or(config_from);

            let mut last_valid_range_start_block = from;

            info!(from = from, "[Messages]: resuming indexer from latest valid message range start block");

            loop {
                indexed_height.set(from as i64);

                // Only index blocks considered final.
                // If there's an error getting the block number, just start the loop over
                let tip = if let Ok(num) = indexer.get_finalized_block_number().await {
                    num
                } else {
                    continue;
                };
                if tip <= from {
                    // Sleep if caught up to tip
                    sleep(Duration::from_secs(1)).await;
                    continue;
                }

                // Index the chunk_size, capping at the tip.
                let to = min(tip, from + chunk_size);

                // Still search the full-size chunk size to possibly catch events that nodes have dropped "close to the tip"
                let full_chunk_from = to.checked_sub(chunk_size).unwrap_or_default();

                let mut sorted_messages: Vec<_> = indexer.fetch_sorted_messages(full_chunk_from, to).await?.into_iter().map(|(msg, _)| msg).collect();

                info!(
                    from = full_chunk_from,
                    to = to,
                    message_count = sorted_messages.len(),
                    "[Messages]: indexed block range"
                );

                // Get the latest known leaf index. All messages whose indices are <= this index
                // have been stored in the DB.
                let last_nonce = db.retrieve_latest_nonce()?;

                // Filter out any messages that have already been successfully indexed and stored.
                // This is necessary if we're re-indexing blocks in hope of finding missing messages.
                if let Some(min_index) = last_nonce {
                    sorted_messages = sorted_messages.into_iter().filter(|m| m.nonce > min_index).collect();
                }

                debug!(
                    from = full_chunk_from,
                    to = to,
                    message_count = sorted_messages.len(),
                    "[Messages]: filtered any messages already indexed"
                );

                // Ensure the sorted messages are a valid continuation of last_nonce
                match validate_message_continuity(last_nonce, &sorted_messages.iter().collect::<Vec<_>>()) {
                    ListValidity::Valid => {
                        // Store messages
                        let max_nonce_of_batch = db.store_messages(&sorted_messages)?;

                        // Report amount of messages stored into db
                        stored_messages.inc_by(sorted_messages.len() as u64);

                        // Report latest leaf index to gauge by dst
                        for msg in sorted_messages.iter() {
                            let dst = name_from_domain_id(msg.destination).unwrap_or_else(|| "unknown".into());
                            message_nonce
                                .with_label_values(&["dispatch", &chain_name, &dst])
                                .set(max_nonce_of_batch as i64);
                        }

                        // Update the latest valid start block.
                        db.store_latest_valid_message_range_start_block(full_chunk_from)?;
                        last_valid_range_start_block = full_chunk_from;

                        // Move forward to the next height
                        from = to + 1;
                    }
                    // The index of the first message in sorted_messages is not the
                    // `last_nonce+1`.
                    ListValidity::InvalidContinuation => {
                        missed_messages.inc();

                        warn!(
                            last_nonce = ?last_nonce,
                            start_block = from,
                            end_block = to,
                            last_valid_range_start_block,
                            "[Messages]: Found invalid continuation in range. Re-indexing from the start block of the last successful range.",
                        );

                        from = last_valid_range_start_block;
                    }
                    ListValidity::ContainsGaps => {
                        missed_messages.inc();

                        warn!(
                            last_nonce = ?last_nonce,
                            start_block = from,
                            end_block = to,
                            "[Messages]: Found gaps in the messages in range, re-indexing the same range.",
                        );
                    }
                    ListValidity::Empty =>  {
                        // Continue if no messages found.
                        // We don't update last_valid_range_start_block because we cannot extrapolate
                        // if the range was correctly indexed if there are no messages to observe their
                        // indices.
                        from = to + 1;
                    }
                };
            }
        })
            .instrument(span)
    }
}

#[cfg(test)]
mod test {
    use std::sync::Arc;
    use std::time::Duration;

    use ethers::core::types::H256;
    use eyre::eyre;
    use mockall::*;
    use tokio::select;
    use tokio::time::{interval, timeout};

    use abacus_core::{db::AbacusDB, AbacusMessage, LogMeta};
    use abacus_test::mocks::indexer::MockAbacusIndexer;
    use abacus_test::test_utils;
    use mockall::predicate::eq;

    use crate::chains::IndexSettings;
    use crate::contract_sync::schema::OutboxContractSyncDB;
    use crate::ContractSync;
    use crate::{ContractSyncMetrics, CoreMetrics};

    #[tokio::test]
    async fn handles_missing_rpc_messages() {
        test_utils::run_test_db(|db| async move {
            let message_gen = |nonce: u32| -> AbacusMessage {
                AbacusMessage {
                    version: 0,
                    nonce,
                    origin: 1000,
                    destination: 2000,
                    sender: H256::from([10; 32]),
                    recipient: H256::from([11; 32]),
                    body: [10u8; 5].to_vec(),
                }
            };

            let messages = (0..10).map(message_gen).collect::<Vec<AbacusMessage>>();

            let meta = || LogMeta {
                address: Default::default(),
                block_number: 0,
                block_hash: Default::default(),
                transaction_hash: Default::default(),
                transaction_index: 0,
                log_index: Default::default(),
            };

            let latest_valid_message_range_start_block = 100;

            let mut mock_indexer = MockAbacusIndexer::new();
            {
                let mut seq = Sequence::new();

                // Return m0.
                let m0 = messages[0].clone();
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(110));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .with(eq(91), eq(110))
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![(m0, meta())]));

                // Return m1, miss m2.
                let m1 = messages[1].clone();
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(120));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .with(eq(101), eq(120))
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![(m1, meta())]));

                // Miss m3.
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(130));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .with(eq(111), eq(130))
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Empty range.
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(140));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .with(eq(121), eq(140))
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(140));

                // m1 --> m5 seen as an invalid continuation
                let m5 = messages[5].clone();
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(150));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .with(eq(131), eq(150))
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![(m5, meta())]));

                // Indexer goes back to the last valid message range start block
                // and indexes the range based off the chunk size of 19.
                // This time it gets m1 and m2 (which was previously skipped)
                let m1 = messages[1].clone();
                let m2 = messages[2].clone();
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(160));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .with(eq(101), eq(120))
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![(m1, meta()), (m2, meta())]));

                // Indexer continues, this time getting m3 and m5 message, but skipping m4,
                // which means this range contains gaps
                let m3 = messages[3].clone();
                let m5 = messages[5].clone();
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(170));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .with(eq(121), eq(140))
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![(m3, meta()), (m5, meta())]));

                // Indexer retries, the same range in hope of filling the gap,
                // which it now does successfully
                let m3 = messages[3].clone();
                let m4 = messages[4].clone();
                let m5 = messages[5].clone();
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(170));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .with(eq(121), eq(140))
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![(m3, meta()), (m4, meta()), (m5, meta())]));

                // Indexer continues with the next block range, which happens to be empty
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(180));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .with(eq(141), eq(160))
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Indexer catches up with the tip
                mock_indexer
                    .expect__get_finalized_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(180));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .times(1)
                    .with(eq(161), eq(180))
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Stay at the same tip, so no other fetch_sorted_messages calls are made
                mock_indexer
                    .expect__get_finalized_block_number()
                    .returning(|| Ok(180));
            }

            let abacus_db = AbacusDB::new("outbox_1", db);

            // Set the latest valid message range start block
            abacus_db
                .store_latest_valid_message_range_start_block(
                    latest_valid_message_range_start_block,
                )
                .unwrap();

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
                    chunk: Some("19".to_string()),
                },
                sync_metrics,
            );

            let sync_task = contract_sync.sync_dispatched_messages();
            let test_pass_fut = timeout(Duration::from_secs(30), async move {
                let mut interval = interval(Duration::from_millis(20));
                loop {
                    if abacus_db.message_by_nonce(0).expect("!db").is_some()
                        && abacus_db.message_by_nonce(1).expect("!db").is_some()
                        && abacus_db.message_by_nonce(2).expect("!db").is_some()
                        && abacus_db.message_by_nonce(3).expect("!db").is_some()
                        && abacus_db.message_by_nonce(4).expect("!db").is_some()
                        && abacus_db.message_by_nonce(5).expect("!db").is_some()
                    {
                        break;
                    }
                    interval.tick().await;
                }
            });
            let test_result = select! {
                 err = sync_task => Err(eyre!(
                    "sync task unexpectedly done before test: {:?}", err.unwrap_err())),
                 tests_result = test_pass_fut =>
                   if tests_result.is_ok() { Ok(()) } else { Err(eyre!("timed out")) }
            };
            assert!(test_result.is_ok());
        })
        .await
    }
}
