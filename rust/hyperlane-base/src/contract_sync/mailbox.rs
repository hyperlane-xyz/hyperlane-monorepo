use std::time::{Duration};

use tracing::{instrument};

use hyperlane_core::{
    Indexer, MailboxIndexer,
    SyncBlockRangeCursor,
};
use tokio::time::sleep;

use crate::{
    ContractSync, MessageSyncBlockRangeCursor,
};

// Okay, a Mailbox sync process takes a block number and a nonce, and it's
// expected to find every message that was sent after that block number and
// nonce.

const MESSAGES_LABEL: &str = "messages";

impl<I> ContractSync<I>
where
    I: MailboxIndexer + Clone + 'static,
{
    /// Sync dispatched messages
    #[instrument(name = "MessageContractSync", skip(self))]
    pub(crate) async fn sync_dispatched_messages(&self, start_block: u32, start_nonce: Option<u32>) -> eyre::Result<()> {
        /*
        let chain_name = self.domain.as_ref();
        let indexed_height = self
            .metrics
            .indexed_height
            .with_label_values(&[MESSAGES_LABEL, chain_name]);
        let stored_messages = self
            .metrics
            .stored_events
            .with_label_values(&[MESSAGES_LABEL, chain_name]);
        let missed_messages = self
            .metrics
            .missed_events
            .with_label_values(&[MESSAGES_LABEL, chain_name]);

        let message_nonce = self.metrics.message_nonce.clone();
        */

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

        /*
        let start_block = cursor.current_position();
        let mut last_valid_range_start_block = start_block;
        info!(
            from = start_block,
            "Resuming indexer from latest valid message range start block"
        );
        indexed_height.set(start_block as i64);
        let mut last_logged_time: Option<Instant> = None;
        let mut should_log_checkpoint_info = || {
            if last_logged_time.is_none()
                || last_logged_time.unwrap().elapsed() > Duration::from_secs(30)
            {
                last_logged_time = Some(Instant::now());
                true
            } else {
                false
            }
        };
        */

        let mut cursor = MessageSyncBlockRangeCursor::new(self.indexer.clone(), self.db.clone(), self.index_settings.chunk_size, start_block, start_nonce).await?;
        loop {
            let Ok(range) = cursor.next_range().await else { continue };
            if range.is_none() {
                // TODO: Define the sleep time from interval flag
                sleep(Duration::from_secs(5)).await;
            } else {
                let (from, to, eta) = range.unwrap();
                let sorted_messages = self
                    .indexer
                    .fetch_sorted_messages(from, to)
                    .await?;

                // TODO: Can we efficiently skip messages that we know have already been
                // inserted?
                self.db.store_dispatched_messages(&sorted_messages)?;
                
                // If we found messages, but did *not* find the message we were looking for,
                // we need to backtrack.
                let desired_nonce = cursor.next_nonce();
                if !sorted_messages.is_empty() && sorted_messages.first().map(|m| m.0.nonce) != Some(desired_nonce) {
                    cursor.backtrack(start_block)?;
                }
            }
        }
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
        db::HyperlaneDB,
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

            let hyperlane_db = HyperlaneDB::new(
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
