use std::time::Duration;

use tracing::{debug, info, instrument, warn};

use hyperlane_core::{HyperlaneDB, MailboxIndexer, MessageSyncCursor, SyncBlockRangeCursor};
use tokio::time::sleep;

use crate::ContractSync;

const DISPATCHED_MESSAGES_LABEL: &str = "dispatched_messages";
const DELIVERED_MESSAGES_LABEL: &str = "delivered_messages";

impl<I> ContractSync<I>
where
    I: MailboxIndexer + Clone + 'static,
{
    /// Sync dispatched messages
    #[instrument(name = "DispatchedMessageSync", skip(self, cursor))]
    pub(crate) async fn sync_dispatched_messages(
        &self,
        mut cursor: Box<dyn MessageSyncCursor>,
    ) -> eyre::Result<()> {
        let chain_name = self.domain.as_ref();
        let stored_dispatched_messages = self
            .metrics
            .stored_events
            .with_label_values(&[DISPATCHED_MESSAGES_LABEL, chain_name]);

        // Indexes messages by fetching messages in ranges of blocks.
        // We've observed occasional flakiness with providers where some events in
        // a range will be missing. The leading theories are:
        //
        // 1. The provider is just flaky and sometimes misses events :(
        //
        // 2. For chains with low finality times, it's possible that when
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
        // looking at the nonce of each message and ensuring that we've indexed
        // the next message that we were looking for.

        info!(next_nonce = cursor.next_nonce(), "Starting message indexer");

        while cursor.fast_forward().await {
            let Ok(range) = cursor.next_range().await else { continue };
            if range.is_none() {
                // TODO: Define the sleep time from interval flag
                sleep(Duration::from_secs(5)).await;
            } else {
                let (from, to, _) = range.unwrap();
                let next_nonce = cursor.next_nonce();

                debug!(
                    from,
                    to, next_nonce, "Looking for for dispatched message(s) in block range"
                );
                // TODO: These don't need to be sorted.
                let sorted_messages = self.indexer.fetch_sorted_messages(from, to).await?;
                info!(
                    from,
                    to,
                    num_messages = sorted_messages.len(),
                    "Found dispatched message(s) in block range"
                );

                let stored = self.db.store_dispatched_messages(&sorted_messages).await?;
                stored_dispatched_messages.inc_by(stored as u64);

                // If we found messages, but did *not* find the message we were looking for,
                // we need to rewind to the block at which we found the last message.
                if !sorted_messages.is_empty()
                    && !sorted_messages.iter().any(|m| m.0.nonce == next_nonce)
                {
                    let rewind_block = cursor.rewind().await?;
                    warn!(
                        from, to,
                        next_nonce,
                        messages=?sorted_messages.iter().map(|m| m.0.clone()),
                        rewind_block,
                        "Expected next dispatched message not found in range, rewound"
                    );
                }
            }
        }
        // TODO: It seems like the relayer shuts down if the task finishes..
        loop {
            // TODO: Define the sleep time from interval flag
            sleep(Duration::from_secs(500)).await;
        }
    }

    /// Sync delivered messages
    #[instrument(name = "DeliveredMessageSync", skip(self, cursor))]
    pub(crate) async fn sync_delivered_messages(
        &self,
        mut cursor: Box<dyn SyncBlockRangeCursor>,
    ) -> eyre::Result<()> {
        let chain_name = self.domain.as_ref();
        let stored_delivered_messages = self
            .metrics
            .stored_events
            .with_label_values(&[DELIVERED_MESSAGES_LABEL, chain_name]);

        loop {
            let Ok(range) = cursor.next_range().await else { continue };
            if range.is_none() {
                // TODO: Define the sleep time from interval flag
                sleep(Duration::from_secs(5)).await;
            } else {
                let (from, to, _) = range.unwrap();
                debug!(
                    from,
                    to, "Looking for for delivered message(s) in block range"
                );

                let deliveries = self.indexer.fetch_delivered_messages(from, to).await?;

                info!(
                    from,
                    to,
                    num_deliveries = deliveries.len(),
                    "Found delivered message(s) in block range"
                );

                // Store deliveries
                let stored = self.db.store_delivered_messages(&deliveries).await?;
                // Report amount of deliveries stored into db
                stored_delivered_messages.inc_by(stored as u64);
            }
        }
    }
}

#[cfg(test)]
mod test {
    use std::sync::Arc;
    use std::time::Duration;

    use eyre::eyre;
    use mockall::{predicate::eq, *};
    use tokio::{
        select,
        sync::Mutex,
        time::{interval, sleep, timeout},
    };

    use hyperlane_core::{HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain, LogMeta, H256};
    use hyperlane_test::mocks::{cursor::MockSyncBlockRangeCursor, indexer::MockHyperlaneIndexer};

    use crate::{
        contract_sync::{mailbox::MOCK_CURSOR, schema::MailboxContractSyncDB, IndexSettings},
        db::test_utils,
        db::HyperlaneRocksDB,
        ContractSync, ContractSyncMetrics, CoreMetrics,
    };

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
                            .return_once(|| {
                                Box::pin(async {
                                    Ok(($expected_from, $expected_to, Duration::from_secs(0)))
                                })
                            });
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
                        Ok((161, 161, Duration::from_secs(0)))
                    })
                });
            }

            let hyperlane_db = HyperlaneRocksDB::new(
                &HyperlaneDomain::new_test_domain("handles_missing_rpc_messages"),
                db,
            );

            // Set the latest valid message range start block
            hyperlane_db
                .store_latest_valid_message_range_start_block(
                    latest_valid_message_range_start_block,
                )
                .unwrap();

            let indexer = Arc::new(mock_indexer);
            let metrics = Arc::new(
                CoreMetrics::new("contract_sync_test", 9090, prometheus::Registry::new())
                    .expect("could not make metrics"),
            );
            unsafe { MOCK_CURSOR = Some(mock_cursor) };

            let sync_metrics = ContractSyncMetrics::new(metrics);

            let contract_sync = ContractSync::new(
                HyperlaneDomain::Known(KnownHyperlaneDomain::Test1),
                hyperlane_db.clone(),
                indexer,
                IndexSettings {
                    from: 0,
                    chunk_size: 19,
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
