use std::{sync::Arc, time::Duration};

use abacus_base::{CachingInbox, CheckpointSyncer, LocalStorage};
use abacus_core::{db::AbacusDB, AbacusCommon, CommittedMessage, Inbox};
use color_eyre::Result;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{debug, info_span, instrument::Instrumented, Instrument};

use crate::tip_prover::{MessageBatch, TipProver};

pub(crate) struct CheckpointRelayer {
    interval: u64,
    db: AbacusDB,
    inbox: Arc<CachingInbox>,
    prover_sync: TipProver,
}

impl CheckpointRelayer {
    pub(crate) fn new(interval: u64, db: AbacusDB, inbox: Arc<CachingInbox>) -> Self {
        Self {
            interval,
            prover_sync: TipProver::from_disk(db.clone()),
            db,
            inbox,
        }
    }

    async fn get_messages_between(
        &self,
        unprocessed_leaf_index: u32,
        latest_signed_checkpoint_index: u32,
    ) -> Result<Option<Vec<CommittedMessage>>> {
        let mut messages: Vec<CommittedMessage> = vec![];
        let mut current_unprocessed_leaf_index = unprocessed_leaf_index;
        while current_unprocessed_leaf_index <= latest_signed_checkpoint_index {
            // Relies on the indexer finding this message eventually
            self.db
                .wait_for_leaf(current_unprocessed_leaf_index)
                .await?;
            let maybe_message = self
                .db
                .message_by_leaf_index(current_unprocessed_leaf_index)?
                .map(CommittedMessage::try_from)
                .transpose()?;
            match maybe_message {
                Some(message) => {
                    if message.message.destination == self.inbox.local_domain() {
                        messages.push(message);
                    }
                }
                None => return Ok(None),
            }
            current_unprocessed_leaf_index += 1
        }

        Ok(Some(messages))
    }

    async fn submit_checkpoint_and_messages(
        &mut self,
        local_storage: &LocalStorage,
        latest_checkpointed_index: u32,
        latest_signed_checkpoint_index: u32,
        messages: Vec<CommittedMessage>,
    ) -> Result<u32> {
        // If the checkpoint storage is inconsistent, then this arm won't match
        // and it will cause us to have skipped this message batch
        if let Some(latest_signed_checkpoint) = local_storage
            .fetch_checkpoint(latest_signed_checkpoint_index)
            .await?
        {
            let batch = MessageBatch::new(
                messages,
                latest_checkpointed_index,
                latest_signed_checkpoint.clone(),
            );
            self.prover_sync.update_from_batch(&batch)?;
            self.inbox
                .submit_checkpoint(&latest_signed_checkpoint)
                .await?;

            // TODO: sign in parallel
            for message in &batch.messages {
                match self.db.proof_by_leaf_index(message.leaf_index)? {
                    Some(proof) => {
                        self.inbox
                            .prove_and_process(&message.message, &proof)
                            .await?;
                    }
                    None => (),
                }
            }

            // Sleep latency period after submission
            sleep(Duration::from_secs(self.interval)).await;
            Ok(latest_signed_checkpoint.checkpoint.index)
        } else {
            Ok(latest_checkpointed_index)
        }
    }

    pub(crate) fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("CheckpointRelayer");
        let local_storage = LocalStorage {
            path: "/tmp/validatorsignatures".to_string(),
        };
        tokio::spawn(async move {
            let latest_inbox_checkpoint = self.inbox.latest_checkpoint(None).await?;
            let mut latest_checkpointed_index = latest_inbox_checkpoint.index;
            // Checkpoints are 1-indexed, while leaves are 0-indexed
            let mut unprocessed_leaf_index = latest_checkpointed_index;
            loop {
                sleep(Duration::from_secs(5)).await;

                if let Some(latest_signed_checkpoint_index) = local_storage.latest_index().await? {
                    if latest_signed_checkpoint_index <= latest_checkpointed_index {
                        debug!(
                            onchain = latest_checkpointed_index,
                            signed = latest_signed_checkpoint_index,
                            "Signed checkpoint matches known checkpoint on-chain, continue"
                        );
                        continue;
                    }

                    match self
                        .get_messages_between(
                            unprocessed_leaf_index,
                            latest_signed_checkpoint_index,
                        )
                        .await?
                    {
                        None => debug!("Couldn't fetch the relevant messages, retry this range"),
                        Some(messages) if messages.is_empty() => {
                            unprocessed_leaf_index = latest_signed_checkpoint_index;
                            debug!("New checkpoint does not include messages for inbox")
                        }
                        Some(messages) => {
                            unprocessed_leaf_index = latest_signed_checkpoint_index;
                            debug!(
                                len = messages.len(),
                                "Signed checkpoint allows for processing of new messages"
                            );

                            latest_checkpointed_index = self
                                .submit_checkpoint_and_messages(
                                    &local_storage,
                                    latest_checkpointed_index,
                                    latest_signed_checkpoint_index,
                                    messages,
                                )
                                .await?;
                        }
                    }
                }
            }
        })
        .instrument(span)
    }
}
