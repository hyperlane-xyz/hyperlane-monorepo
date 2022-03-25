use std::{sync::Arc, time::Duration};

use abacus_base::CachingInbox;
use abacus_core::{db::AbacusDB, AbacusCommon, CommittedMessage, Inbox, MessageStatus};
use color_eyre::{eyre::bail, Result};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use crate::merkle_tree_builder::MerkleTreeBuilder;

pub(crate) struct MessageProcessor {
    polling_interval: u64,
    reorg_period: u64,
    db: AbacusDB,
    inbox: Arc<CachingInbox>,
    prover_sync: MerkleTreeBuilder,
}

impl MessageProcessor {
    pub(crate) fn new(
        polling_interval: u64,
        db: AbacusDB,
        reorg_period: u64,
        inbox: Arc<CachingInbox>,
    ) -> Self {
        Self {
            polling_interval,
            reorg_period,
            prover_sync: MerkleTreeBuilder::new(db.clone()),
            db,
            inbox,
        }
    }

    pub(crate) fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MessageProcessor");

        let mut prover_checkpoint_index = 0;
        let mut message_leaf_index = 0;
        tokio::spawn(async move {
            loop {
                // check for message status
                self.db.wait_for_leaf(message_leaf_index).await?;
                match (
                    self.db.leaf_by_leaf_index(message_leaf_index)?,
                    self.db
                        .message_by_leaf_index(message_leaf_index)?
                        .map(CommittedMessage::try_from)
                        .transpose()?,
                ) {
                    (Some(leaf), Some(message)) => {
                        if message.message.destination != self.inbox.local_domain() {
                            message_leaf_index += 1;
                            continue;
                        }
                        match self.inbox.message_status(leaf).await? {
                            MessageStatus::None => {
                                if message_leaf_index >= prover_checkpoint_index {
                                    // gotta find a root that includes the message
                                    let latest_checkpoint = self
                                        .inbox
                                        .latest_checkpoint(Some(self.reorg_period))
                                        .await?;

                                    self.prover_sync
                                        .update_to_checkpoint(&latest_checkpoint)
                                        .await?;

                                    prover_checkpoint_index = latest_checkpoint.index;
                                    if message_leaf_index >= prover_checkpoint_index {
                                        // If we still don't have an up to date checkpoint, sleep and try again
                                        sleep(Duration::from_secs(self.polling_interval)).await;
                                        continue;
                                    }
                                }

                                if let Some(proof) =
                                    self.db.proof_by_leaf_index(message_leaf_index)?
                                {
                                    self.inbox
                                        .prove_and_process(&message.message, &proof)
                                        .await?;
                                    info!(
                                        leaf_index = message_leaf_index,
                                        "[MessageProcessor] processed"
                                    );
                                    message_leaf_index += 1;
                                } else {
                                    // Should not get here
                                    bail!("Somehow MessageProcessor did not get the proof");
                                }
                            }
                            MessageStatus::Proven => {
                                self.inbox.process(&message.message).await?;
                                message_leaf_index += 1;
                            }
                            MessageStatus::Processed => {
                                message_leaf_index += 1;
                            }
                        }
                    }
                    _ => {
                        // Should not get here
                        bail!("Somehow MessageProcessor get the leaf despite waiting for it");
                    }
                }
            }
        })
        .instrument(span)
    }
}
