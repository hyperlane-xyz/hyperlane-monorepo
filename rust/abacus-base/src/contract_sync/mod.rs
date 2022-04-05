// TODO: Reapply tip buffer
// TODO: Reapply metrics

use crate::settings::IndexSettings;
use abacus_core::db::AbacusDB;
use abacus_core::{AbacusCommonIndexer, ListValidity, OutboxIndexer};

use tokio::time::sleep;
use tracing::{info, info_span, warn};
use tracing::{instrument::Instrumented, Instrument};

use std::cmp::min;
use std::sync::Arc;
use std::time::Duration;

mod last_message;
mod metrics;
mod schema;

use last_message::OptLatestLeafIndex;
pub use metrics::ContractSyncMetrics;
use schema::{HomeContractSyncDB};

const MESSAGES_LABEL: &str = "messages";

/// Entity that drives the syncing of an agent's db with on-chain data.
/// Extracts chain-specific data (emitted updates, messages, etc) from an
/// `indexer` and fills the agent's db with this data. A CachingHome or
/// CachingReplica will use a contract sync to spawn syncing tasks to keep the
/// db up-to-date.
#[derive(Debug)]
pub struct ContractSync<I> {
    agent_name: String,
    contract_name: String,
    db: AbacusDB,
    indexer: Arc<I>,
    index_settings: IndexSettings,
    metrics: ContractSyncMetrics,
}

impl<I> ContractSync<I> {
    /// Instantiate new ContractSync
    pub fn new(
        agent_name: String,
        contract_name: String,
        db: AbacusDB,
        indexer: Arc<I>,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Self {
        Self {
            agent_name,
            contract_name,
            db,
            indexer,
            index_settings,
            metrics,
        }
    }
}

impl<I> ContractSync<I>
where
    I: AbacusCommonIndexer + 'static,
{
    /// TODO: Not implemented
    pub fn sync_checkpoints(
        &self,
    ) -> Instrumented<tokio::task::JoinHandle<color_eyre::Result<()>>> {
        let span = info_span!("MessageContractSync");

        tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(1)).await;
            }
        })
        .instrument(span)
    }
}

impl<I> ContractSync<I>
where
    I: OutboxIndexer + 'static,
{
    /// Sync outbox messages
    pub fn sync_outbox_messages(
        &self,
    ) -> Instrumented<tokio::task::JoinHandle<color_eyre::Result<()>>> {
        let span = info_span!("MessageContractSync");

        let db = self.db.clone();
        let indexer = self.indexer.clone();
        let indexed_height = self.metrics.indexed_height.clone().with_label_values(&[
            MESSAGES_LABEL,
            &self.contract_name,
            &self.agent_name,
        ]);

        let stored_messages = self.metrics.stored_events.clone().with_label_values(&[
            MESSAGES_LABEL,
            &self.contract_name,
            &self.agent_name,
        ]);

        let missed_messages = self.metrics.missed_events.clone().with_label_values(&[
            MESSAGES_LABEL,
            &self.contract_name,
            &self.agent_name,
        ]);

        let message_leaf_index = self.metrics.message_leaf_index.clone();

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

            info!(from = from, "[Messages]: resuming indexer from {}", from);

            // Set the metrics with the latest known leaf index
            if let Ok(Some(idx)) = db.retrieve_latest_leaf_index() {
                if let Some(gauge) = message_leaf_index.as_ref() {
                    gauge.set(idx as i64);
                }
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

                let tip = indexer.get_block_number().await?;
                if tip <= from {
                    // TODO: Make this configurable
                    // Sleep if caught up to tip
                    sleep(Duration::from_secs(1)).await;
                    continue;
                }

                let candidate = from + chunk_size;
                let to = min(tip, candidate);

                info!(
                    from = from,
                    to = to,
                    "[Messages]: indexing block heights {}...{}",
                    from,
                    to
                );

                let sorted_messages = indexer.fetch_sorted_messages(from, to).await?;

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
                        if let Some(gauge) = message_leaf_index.as_ref() {
                            gauge.set(max_leaf_index_of_batch as i64);
                        }

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
                                "[Messages]: RPC failed to find message(s) between blocks {}...{}. Last seen leaf index: {:?}. Activating finding_missing mode.",
                                from,
                                to,
                                last_leaf_index,
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
    use abacus_test::mocks::MockIndexer;
    use mockall::*;

    use std::sync::Arc;

    use ethers::core::types::H256;
    use ethers::signers::LocalWallet;

    use abacus_core::{
        AbacusMessage, Encode, RawCommittedMessage, SignedUpdateWithMeta, Update, UpdateMeta,
    };
    use abacus_test::test_utils;

    use super::*;
    use crate::CoreMetrics;

    #[tokio::test]
    async fn handles_missing_rpc_updates() {
        test_utils::run_test_db(|db| async move {
            let signer: LocalWallet =
                "1111111111111111111111111111111111111111111111111111111111111111"
                    .parse()
                    .unwrap();

            let first_root = H256::from([0; 32]);
            let second_root = H256::from([1; 32]);
            let third_root = H256::from([2; 32]);
            let fourth_root = H256::from([3; 32]);
            let fifth_root = H256::from([4; 32]);
            let sixth_root = H256::from([4; 32]);

            let first_update = Update {
                home_domain: 1,
                previous_root: first_root,
                new_root: second_root,
            }
            .sign_with(&signer)
            .await
            .expect("!sign");

            let second_update = Update {
                home_domain: 1,
                previous_root: second_root,
                new_root: third_root,
            }
            .sign_with(&signer)
            .await
            .expect("!sign");

            let third_update = Update {
                home_domain: 1,
                previous_root: third_root,
                new_root: fourth_root,
            }
            .sign_with(&signer)
            .await
            .expect("!sign");

            let fourth_update = Update {
                home_domain: 1,
                previous_root: fourth_root,
                new_root: fifth_root,
            }
            .sign_with(&signer)
            .await
            .expect("!sign");

            let fifth_update = Update {
                home_domain: 1,
                previous_root: fifth_root,
                new_root: sixth_root,
            }
            .sign_with(&signer)
            .await
            .expect("!sign");

            let mut mock_indexer = MockIndexer::new();
            {
                let mut seq = Sequence::new();

                let first_update_with_meta = SignedUpdateWithMeta {
                    signed_update: first_update.clone(),
                    metadata: UpdateMeta { block_number: 5 },
                };

                let second_update_with_meta = SignedUpdateWithMeta {
                    signed_update: second_update.clone(),
                    metadata: UpdateMeta { block_number: 15 },
                };
                let second_update_with_meta_clone = second_update_with_meta.clone();

                let third_update_with_meta = SignedUpdateWithMeta {
                    signed_update: third_update.clone(),
                    metadata: UpdateMeta { block_number: 15 },
                };

                let fourth_update_with_meta = SignedUpdateWithMeta {
                    signed_update: fourth_update.clone(),
                    metadata: UpdateMeta { block_number: 25 },
                };
                let fourth_update_with_meta_clone_1 = fourth_update_with_meta.clone();
                let fourth_update_with_meta_clone_2 = fourth_update_with_meta.clone();

                let fifth_update_with_meta = SignedUpdateWithMeta {
                    signed_update: fifth_update.clone(),
                    metadata: UpdateMeta { block_number: 55 },
                };
                let fifth_update_with_meta_clone_1 = fifth_update_with_meta.clone();
                let fifth_update_with_meta_clone_2 = fifth_update_with_meta.clone();
                let fifth_update_with_meta_clone_3 = fifth_update_with_meta.clone();

                // Return first update
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![first_update_with_meta]));

                // Return second update, misses third update
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![second_update_with_meta]));

                // --> miss fourth update
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Next block range is empty updates
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // second --> return fifth update is invalid
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_update_with_meta]));

                // Indexer goes back and tries empty block range
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
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
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_update_with_meta_clone_1]));

                // Indexer goes back further and gets to the fourth update
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fourth_update_with_meta_clone_1]));

                // Indexer goes further for empty range
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Indexer goes back further and gets to the fifth update
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_update_with_meta_clone_2]));

                // Indexer goes back even further to find 2nd and 3rd update
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| {
                        Ok(vec![second_update_with_meta_clone, third_update_with_meta])
                    });

                // Indexer goes forward and gets to the fourth update again
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fourth_update_with_meta_clone_2]));

                // Indexer goes further for empty range
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![]));

                // Indexer goes back further and gets to the fifth update
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(move |_, _| Ok(vec![fifth_update_with_meta_clone_3]));

                // Return empty vec for remaining calls
                mock_indexer
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_updates()
                    .return_once(move |_, _| Ok(vec![]));
            }

            let abacus_db = AbacusDB::new("home_1", db);

            let indexer = Arc::new(mock_indexer);
            let metrics = Arc::new(
                CoreMetrics::new(
                    "contract_sync_test",
                    None,
                    Arc::new(prometheus::Registry::new()),
                )
                .expect("could not make metrics"),
            );

            let sync_metrics = ContractSyncMetrics::new(metrics, None);

            let contract_sync = ContractSync::new(
                "agent".to_owned(),
                "home_1".to_owned(),
                abacus_db.clone(),
                indexer.clone(),
                IndexSettings {
                    from: Some("0".to_string()),
                    chunk: Some("10".to_string()),
                },
                sync_metrics,
            );

            let sync_task = contract_sync.sync_updates();
            sleep(Duration::from_secs(3)).await;
            cancel_task!(sync_task);

            assert_eq!(
                abacus_db
                    .update_by_previous_root(first_root)
                    .expect("!db")
                    .expect("!update"),
                first_update.clone()
            );
            assert_eq!(
                abacus_db
                    .update_by_previous_root(second_root)
                    .expect("!db")
                    .expect("!update"),
                second_update.clone()
            );
            assert_eq!(
                abacus_db
                    .update_by_previous_root(third_root)
                    .expect("!db")
                    .expect("!update"),
                third_update.clone()
            );
            assert_eq!(
                abacus_db
                    .update_by_previous_root(fourth_root)
                    .expect("!db")
                    .expect("!update"),
                fourth_update.clone()
            );

            assert_eq!(
                abacus_db
                    .update_by_previous_root(fifth_root)
                    .expect("!db")
                    .expect("!update"),
                fifth_update.clone()
            );
        })
        .await
    }

    #[tokio::test]
    async fn handles_missing_rpc_messages() {
        test_utils::run_test_db(|db| async move {
            let first_root = H256::from([0; 32]);
            let second_root = H256::from([1; 32]);
            let third_root = H256::from([2; 32]);
            let fourth_root = H256::from([2; 32]);

            let mut message_vec = vec![];
            AbacusMessage {
                origin: 1000,
                destination: 2000,
                sender: H256::from([10; 32]),
                nonce: 1,
                recipient: H256::from([11; 32]),
                body: [10u8; 5].to_vec(),
            }
            .write_to(&mut message_vec)
            .expect("!write_to");

            let first_message = RawCommittedMessage {
                leaf_index: 0,
                committed_root: first_root,
                message: message_vec.clone(),
            };

            let second_message = RawCommittedMessage {
                leaf_index: 1,
                committed_root: second_root,
                message: message_vec.clone(),
            };
            let second_message_clone = second_message.clone();

            let third_message = RawCommittedMessage {
                leaf_index: 2,
                committed_root: second_root,
                message: message_vec.clone(),
            };

            let fourth_message = RawCommittedMessage {
                leaf_index: 3,
                committed_root: third_root,
                message: message_vec.clone(),
            };
            let fourth_message_clone_1 = fourth_message.clone();
            let fourth_message_clone_2 = fourth_message.clone();

            let fifth_message = RawCommittedMessage {
                leaf_index: 4,
                committed_root: fourth_root,
                message: message_vec.clone(),
            };
            let fifth_message_clone_1 = fifth_message.clone();
            let fifth_message_clone_2 = fifth_message.clone();
            let fifth_message_clone_3 = fifth_message.clone();

            let mut mock_indexer = MockIndexer::new();
            {
                let mut seq = Sequence::new();

                // Return first message
                mock_indexer
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
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
                    .expect__get_block_number()
                    .times(1)
                    .in_sequence(&mut seq)
                    .return_once(|| Ok(100));
                mock_indexer
                    .expect__fetch_sorted_messages()
                    .return_once(move |_, _| Ok(vec![]));
            }

            let abacus_db = AbacusDB::new("home_1", db);

            let indexer = Arc::new(mock_indexer);
            let metrics = Arc::new(
                CoreMetrics::new(
                    "contract_sync_test",
                    None,
                    Arc::new(prometheus::Registry::new()),
                )
                .expect("could not make metrics"),
            );

            let sync_metrics = ContractSyncMetrics::new(metrics, None);

            let contract_sync = ContractSync::new(
                "agent".to_owned(),
                "home_1".to_owned(),
                abacus_db.clone(),
                indexer.clone(),
                IndexSettings {
                    from: Some("0".to_string()),
                    chunk: Some("10".to_string()),
                },
                sync_metrics,
            );

            let sync_task = contract_sync.sync_messages();
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
