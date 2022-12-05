use tracing::{debug, info, info_span, warn};
use tracing::{instrument::Instrumented, Instrument};

use hyperlane_core::{
    name_from_domain_id, Indexer, ListValidity, MailboxIndexer, SyncBlockRangeCursor,
};

use crate::contract_sync::last_message::validate_message_continuity;
use crate::{contract_sync::schema::MailboxContractSyncDB, ContractSync};

const MESSAGES_LABEL: &str = "messages";

impl<I> ContractSync<I>
where
    I: MailboxIndexer + Clone + 'static,
{
    /// Sync dispatched messages
    pub fn sync_dispatched_messages(
        &self,
    ) -> Instrumented<tokio::task::JoinHandle<eyre::Result<()>>> {
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

        let cursor = {
            let config_initial_height = self.index_settings.from();
            let initial_height = db
                .retrieve_latest_valid_message_range_start_block()
                .map_or(config_initial_height, |b| b + 1);
            create_cursor(
                indexer.clone(),
                self.index_settings.chunk_size(),
                initial_height,
            )
        };

        // Indexes messages by fetching messages in ranges of blocks.
        // We've observed occasional flakiness with providers where some events in
        // a range will be missing. The leading theories are:
        //
        // 1. The provider is just flaky and sometimes misses events :(
        //
        // 2. For outbox chains with low finality times, it's possible that when
        // we query the RPC provider for the latest finalized block number,
        // we're returned a block number T. However when we attempt to index a range
        // where the `to` block is T, the `eth_getLogs` RPC is load balanced by the
        // provider to a different node whose latest known block is some block T' <T.
        //
        // The `eth_getLogs` RPC implementations seem to happily accept
        // `to` blocks that exceed the latest known block, so it's possible
        // that in our indexer we think that we've indexed up to block T but
        // we've only *actually* indexed up to block T'.
        //
        // It's easy to determine if a provider has skipped any message events by
        // looking at the indices of each message and ensuring that we've indexed a
        // valid continuation of messages.
        //
        // There are two classes of invalid continuations:
        //
        // 1. The latest previously indexed message index is M that was found in a
        // previously indexed block range. A new block range [A,B] is indexed, returning
        // a list of messages. The lowest message index in that list is `M + 1`,
        // but there are some missing messages indices in the list. This is
        // likely a flaky provider, and we can simply re-index the range [A,B]
        // hoping that the provider will soon return a correct list.
        //
        // 2. The latest previously indexed message index is M that was found in a
        // previously indexed block range, [A,B]. A new block range [C,D] is
        // indexed, returning a list of    messages. However, the lowest message
        // index in that list is M' where M' > M + 1. This missing messages
        // could be anywhere in the range [A,D]:
        //    * It's possible there was an issue when the prior block range [A,B] was
        //      indexed, where the provider didn't provide some messages with indices >
        //      M that it should have.
        //    * It's possible that the range [B,C] that was presumed to be empty when it
        //      was indexed actually wasn't.
        //    * And it's possible that this was just a flaky gap, where there are
        //      messages in the [C,D] range that weren't returned for some reason.
        //
        // We can handle this by re-indexing starting from block A.
        // Note this means we only handle this case upon observing messages in some
        // range [C,D] that indicate a previously indexed range may have
        // missed some messages.
        tokio::spawn(async move {
            let mut cursor = cursor.await?;

            let start_block = cursor.current_position();
            let mut last_valid_range_start_block = start_block;
            info!(from = start_block, "[Messages]: resuming indexer from latest valid message range start block");
            indexed_height.set(start_block as i64);

            loop {
                let start_block = cursor.current_position();
                let (from, to) = match cursor.next_range().await {
                    Ok(range) => range,
                    Err(err) => {
                        warn!(error = %err, "[Messages]: failed to get next block range");
                        continue;
                    }
                };

                let mut sorted_messages: Vec<_> = indexer
                    .fetch_sorted_messages(from, to)
                    .await?
                    .into_iter()
                    .map(|(msg, _)| msg)
                    .collect();

                info!(from, to, message_count = sorted_messages.len(), "[Messages]: indexed block range");

                // Get the latest known nonce. All messages whose indices are <= this index
                // have been stored in the DB.
                let last_nonce = db.retrieve_latest_nonce()?;

                // Filter out any messages that have already been successfully indexed and stored.
                // This is necessary if we're re-indexing blocks in hope of finding missing messages.
                if let Some(min_nonce) = last_nonce {
                    sorted_messages.retain(|m| m.nonce > min_nonce);
                }

                debug!(from, to, message_count = sorted_messages.len(), "[Messages]: filtered any messages already indexed");

                // Ensure the sorted messages are a valid continuation of last_nonce
                match validate_message_continuity(last_nonce, &sorted_messages.iter().collect::<Vec<_>>()) {
                    ListValidity::Valid => {
                        // Store messages
                        let max_nonce_of_batch = db.store_messages(&sorted_messages)?;

                        // Report amount of messages stored into db
                        stored_messages.inc_by(sorted_messages.len() as u64);

                        // Report latest nonce to gauge by dst
                        for msg in sorted_messages.iter() {
                            let dst = name_from_domain_id(msg.destination).unwrap_or_else(|| "unknown".into());
                            message_nonce
                                .with_label_values(&["dispatch", &chain_name, &dst])
                                .set(max_nonce_of_batch as i64);
                        }

                        // Update the latest valid start block.
                        db.store_latest_valid_message_range_start_block(from)?;
                        last_valid_range_start_block = from;

                        // Move forward to the next height
                        indexed_height.set(to as i64);
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

                        cursor.backtrack(last_valid_range_start_block);
                        indexed_height.set(last_valid_range_start_block as i64);
                    }
                    ListValidity::ContainsGaps => {
                        missed_messages.inc();
                        cursor.backtrack(start_block);

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
                        indexed_height.set(to as i64);
                    }
                };
            }
        })
            .instrument(span)
    }
}

#[cfg(test)]
static mut MOCK_CURSOR: Option<hyperlane_test::mocks::cursor::MockSyncBlockRangeCursor> = None;

/// Create a new cursor. In test mode we should use the mock cursor created by
/// the test.
#[cfg_attr(test, allow(unused_variables))]
async fn create_cursor<I: Indexer>(
    indexer: I,
    chunk_size: u32,
    initial_height: u32,
) -> eyre::Result<impl SyncBlockRangeCursor> {
    #[cfg(not(test))]
    {
        crate::RateLimitedSyncBlockRangeCursor::new(indexer, chunk_size, initial_height).await
    }
    #[cfg(test)]
    {
        let cursor = unsafe { MOCK_CURSOR.take() };
        Ok(cursor.expect("Mock cursor was not set before it was used"))
    }
}

#[cfg(test)]
mod test {
    use std::sync::Arc;
    use std::time::Duration;

    use ethers::core::types::H256;
    use eyre::eyre;
    use mockall::predicate::eq;
    use mockall::*;
    use tokio::select;
    use tokio::sync::Mutex;
    use tokio::time::{interval, sleep, timeout};

    use hyperlane_core::{db::HyperlaneDB, HyperlaneMessage, LogMeta};
    use hyperlane_test::mocks::cursor::MockSyncBlockRangeCursor;
    use hyperlane_test::mocks::indexer::MockHyperlaneIndexer;
    use hyperlane_test::test_utils;

    use crate::contract_sync::mailbox::MOCK_CURSOR;
    use crate::contract_sync::schema::MailboxContractSyncDB;
    use crate::contract_sync::IndexSettings;
    use crate::ContractSync;
    use crate::{ContractSyncMetrics, CoreMetrics};

    // we need a mutex for our tests because of the static cursor object
    lazy_static! {
        static ref TEST_MTX: Mutex<()> = Mutex::new(());
    }

    #[tokio::test]
    async fn handles_missing_rpc_messages() {
        test_utils::run_test_db(|db| async move {
            let message_gen = |nonce: u32| -> HyperlaneMessage {
                HyperlaneMessage {
                    version: 0,
                    nonce,
                    origin: 1000,
                    destination: 2000,
                    sender: H256::from([10; 32]),
                    recipient: H256::from([11; 32]),
                    body: [10u8; 5].to_vec(),
                }
            };

            let messages = (0..10).map(message_gen).collect::<Vec<HyperlaneMessage>>();
            let m0 = messages[0].clone();
            let m1 = messages[1].clone();
            let m2 = messages[2].clone();
            let m3 = messages[3].clone();
            let m4 = messages[4].clone();
            let m5 = messages[5].clone();

            let meta = || LogMeta {
                address: Default::default(),
                block_number: 0,
                block_hash: Default::default(),
                transaction_hash: Default::default(),
                transaction_index: 0,
                log_index: Default::default(),
            };

            let latest_valid_message_range_start_block = 100;

            let mut mock_indexer = MockHyperlaneIndexer::new();
            let mut mock_cursor = MockSyncBlockRangeCursor::new();
            {
                let mut seq = Sequence::new();

                // Some local macros to reduce code-duplication.
                macro_rules! expect_current_position {
                    ($return_position:literal) => {
                        mock_cursor
                            .expect__current_position()
                            .times(1)
                            .in_sequence(&mut seq)
                            .return_once(|| $return_position);
                    };
                }
                macro_rules! expect_backtrack {
                    ($expected_new_from:literal) => {
                        mock_cursor
                            .expect__backtrack()
                            .times(1)
                            .in_sequence(&mut seq)
                            .with(eq($expected_new_from))
                            .return_once(|_| ());
                    };
                }
                macro_rules! expect_fetches_range {
                    ($expected_from:literal, $expected_to:literal, $return_messages:expr) => {
                        let messages: &[&HyperlaneMessage] = $return_messages;
                        let messages = messages.iter().map(|&msg| (msg.clone(), meta())).collect();
                        mock_cursor
                            .expect__next_range()
                            .times(1)
                            .in_sequence(&mut seq)
                            .return_once(|| Box::pin(async { Ok(($expected_from, $expected_to)) }));
                        mock_indexer
                            .expect__fetch_sorted_messages()
                            .times(1)
                            .with(eq($expected_from), eq($expected_to))
                            .in_sequence(&mut seq)
                            .return_once(move |_, _| Ok(messages));
                    };
                }

                expect_current_position!(91);
                expect_current_position!(91);

                // Return m0.
                expect_fetches_range!(91, 110, &[&m0]);

                // Return m1, miss m2.
                expect_current_position!(111);
                expect_fetches_range!(101, 120, &[&m1]);

                // Miss m3.
                expect_current_position!(121);
                expect_fetches_range!(111, 130, &[]);

                // Empty range.
                expect_current_position!(131);
                expect_fetches_range!(121, 140, &[]);

                // m1 --> m5 seen as an invalid continuation
                expect_current_position!(141);
                expect_fetches_range!(131, 150, &[&m5]);
                expect_backtrack!(101);

                // Indexer goes back to the last valid message range start block
                // and indexes the range
                // This time it gets m1 and m2 (which was previously skipped)
                expect_current_position!(101);
                expect_fetches_range!(101, 120, &[&m1, &m2]);

                // Indexer continues, this time getting m3 and m5 message, but skipping m4,
                // which means this range contains gaps
                expect_current_position!(121);
                expect_fetches_range!(118, 140, &[&m3, &m5]);
                expect_backtrack!(121);

                // Indexer retries, the same range in hope of filling the gap,
                // which it now does successfully
                expect_current_position!(121);
                expect_fetches_range!(121, 140, &[&m3, &m4, &m5]);

                // Indexer continues with the next block range, which happens to be empty
                expect_current_position!(141);
                expect_fetches_range!(141, 160, &[]);

                // Stay at the same tip, so no other fetch_sorted_messages calls are made
                mock_cursor.expect__current_position().returning(|| 161);
                mock_cursor.expect__next_range().returning(|| {
                    Box::pin(async move {
                        // this sleep should be longer than the test timeout since we don't actually
                        // want to yield any more values at this point.
                        sleep(Duration::from_secs(100)).await;
                        Ok((161, 161))
                    })
                });
            }

            let hyperlane_db = HyperlaneDB::new("outbox_1", db);

            // Set the latest valid message range start block
            hyperlane_db
                .store_latest_valid_message_range_start_block(
                    latest_valid_message_range_start_block,
                )
                .unwrap();

            let indexer = Arc::new(mock_indexer);
            let metrics = Arc::new(
                CoreMetrics::new("contract_sync_test", None, prometheus::Registry::new())
                    .expect("could not make metrics"),
            );
            unsafe { MOCK_CURSOR = Some(mock_cursor) };

            let sync_metrics = ContractSyncMetrics::new(metrics);

            let contract_sync = ContractSync::new(
                "outbox_1".into(),
                hyperlane_db.clone(),
                indexer,
                IndexSettings {
                    from: Some("0".to_string()),
                    chunk: Some("19".to_string()),
                },
                sync_metrics,
            );

            let sync_task = contract_sync.sync_dispatched_messages();
            let test_pass_fut = timeout(Duration::from_secs(5), async move {
                let mut interval = interval(Duration::from_millis(20));
                loop {
                    if hyperlane_db.message_by_nonce(0).expect("!db").is_some()
                        && hyperlane_db.message_by_nonce(1).expect("!db").is_some()
                        && hyperlane_db.message_by_nonce(2).expect("!db").is_some()
                        && hyperlane_db.message_by_nonce(3).expect("!db").is_some()
                        && hyperlane_db.message_by_nonce(4).expect("!db").is_some()
                        && hyperlane_db.message_by_nonce(5).expect("!db").is_some()
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
            if let Err(err) = test_result {
                panic!("Test failed: {err}")
            }
        })
        .await
    }
}
