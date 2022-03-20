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
        from_leaf_index: u32,
        to_leaf_index: u32,
    ) -> Result<Option<Vec<CommittedMessage>>> {
        let mut messages: Vec<CommittedMessage> = vec![];
        let mut current_leaf_index = from_leaf_index;
        while current_leaf_index <= to_leaf_index {
            // Relies on the indexer finding this message eventually
            self.db.wait_for_leaf(current_leaf_index).await?;
            let maybe_message = self
                .db
                .message_by_leaf_index(current_leaf_index)?
                .map(CommittedMessage::try_from)
                .transpose()?;
            match maybe_message {
                Some(message) => {
                    if message.message.destination == self.inbox.local_domain() {
                        messages.push(message);
                    }
                }
                // This should never happen, but if it does, retry the range
                None => return Ok(None),
            }
            current_leaf_index += 1
        }

        Ok(Some(messages))
    }

    // Returns the newest "current" checkpoint index
    async fn submit_checkpoint_and_messages(
        &mut self,
        local_storage: &LocalStorage,
        onchain_checkpoint_index: u32,
        signed_checkpoint_index: u32,
        messages: Vec<CommittedMessage>,
    ) -> Result<u32> {
        // If the checkpoint storage is inconsistent, then this arm won't match
        // and it will cause us to have skipped this message batch
        if let Some(latest_signed_checkpoint) = local_storage
            .fetch_checkpoint(signed_checkpoint_index)
            .await?
        {
            let batch = MessageBatch::new(
                messages,
                onchain_checkpoint_index,
                latest_signed_checkpoint.clone(),
            );
            self.prover_sync.update_from_batch(&batch)?;
            self.inbox
                .submit_checkpoint(&latest_signed_checkpoint)
                .await?;

            // TODO: sign in parallel
            for message in &batch.messages {
                if let Some(proof) = self.db.proof_by_leaf_index(message.leaf_index)? {
                    self.inbox
                        .prove_and_process(&message.message, &proof)
                        .await?;
                }
            }

            // Sleep latency period after submission
            sleep(Duration::from_secs(self.interval)).await;
            Ok(latest_signed_checkpoint.checkpoint.index)
        } else {
            Ok(onchain_checkpoint_index)
        }
    }

    pub(crate) fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("CheckpointRelayer");
        let local_storage = LocalStorage {
            path: "/tmp/validatorsignatures".to_string(),
        };
        tokio::spawn(async move {
            let latest_inbox_checkpoint = self.inbox.latest_checkpoint(None).await?;
            let mut onchain_checkpoint_index = latest_inbox_checkpoint.index;
            // Checkpoints are 1-indexed, while leaves are 0-indexed
            let mut next_inbox_leaf_index = onchain_checkpoint_index;
            loop {
                sleep(Duration::from_secs(5)).await;

                if let Some(signed_checkpoint_index) = local_storage.latest_index().await? {
                    if signed_checkpoint_index <= onchain_checkpoint_index {
                        debug!(
                            onchain = onchain_checkpoint_index,
                            signed = signed_checkpoint_index,
                            "Signed checkpoint matches known checkpoint on-chain, continue"
                        );
                        continue;
                    }

                    match self
                        .get_messages_between(next_inbox_leaf_index, signed_checkpoint_index)
                        .await?
                    {
                        None => debug!("Couldn't fetch the relevant messages, retry this range"),
                        Some(messages) if messages.is_empty() => {
                            next_inbox_leaf_index = signed_checkpoint_index;
                            debug!("New checkpoint does not include messages for inbox")
                        }
                        Some(messages) => {
                            next_inbox_leaf_index = signed_checkpoint_index;
                            debug!(
                                len = messages.len(),
                                "Signed checkpoint allows for processing of new messages"
                            );

                            onchain_checkpoint_index = self
                                .submit_checkpoint_and_messages(
                                    &local_storage,
                                    onchain_checkpoint_index,
                                    signed_checkpoint_index,
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
