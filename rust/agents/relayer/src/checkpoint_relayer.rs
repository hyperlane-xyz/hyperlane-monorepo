use std::time::Duration;

use abacus_base::{InboxContracts, MultisigCheckpointSyncer, Outboxes};
use abacus_core::{db::AbacusDB, AbacusCommon, CommittedMessage, Inbox, InboxValidatorManager};
use color_eyre::Result;
use prometheus::{IntGauge, IntGaugeVec};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{debug, error, info, info_span, instrument, instrument::Instrumented, Instrument};

use crate::merkle_tree_builder::{MerkleTreeBuilder, MessageBatch};

pub(crate) struct CheckpointRelayer {
    polling_interval: u64,
    /// The minimum latency in seconds between two relayed checkpoints on the inbox
    submission_latency: u64,
    immediate_message_processing: bool,
    db: AbacusDB,
    inbox_contracts: InboxContracts,
    prover_sync: MerkleTreeBuilder,
    multisig_checkpoint_syncer: MultisigCheckpointSyncer,
    signed_checkpoint_gauge: IntGauge,
    inbox_checkpoint_gauge: IntGauge,
    relayer_processed_gauge: IntGauge,
}

impl CheckpointRelayer {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        outbox: Outboxes,
        polling_interval: u64,
        submission_latency: u64,
        immediate_message_processing: bool,
        db: AbacusDB,
        inbox_contracts: InboxContracts,
        multisig_checkpoint_syncer: MultisigCheckpointSyncer,
        leaf_index_gauge: IntGaugeVec,
    ) -> Self {
        let signed_checkpoint_gauge = leaf_index_gauge.with_label_values(&[
            "signed_offchain_checkpoint",
            outbox.name(),
            inbox_contracts.inbox.name(),
        ]);
        let inbox_checkpoint_gauge = leaf_index_gauge.with_label_values(&[
            "inbox_checkpoint",
            outbox.name(),
            inbox_contracts.inbox.name(),
        ]);
        let relayer_processed_gauge = leaf_index_gauge.with_label_values(&[
            "relayer_processed",
            outbox.name(),
            inbox_contracts.inbox.name(),
        ]);
        Self {
            polling_interval,
            immediate_message_processing,
            submission_latency,
            prover_sync: MerkleTreeBuilder::new(db.clone()),
            db,
            inbox_contracts,
            multisig_checkpoint_syncer,
            signed_checkpoint_gauge,
            inbox_checkpoint_gauge,
            relayer_processed_gauge,
        }
    }

    /// Only gets the messages desinated for the Relayers inbox
    /// Inclusive the to_checkpoint_index
    #[instrument(ret, err, skip(self), level = "debug")]
    async fn get_messages_between(
        &self,
        from_leaf_index: u32,
        to_checkpoint_index: u32,
    ) -> Result<Option<Vec<CommittedMessage>>> {
        let mut messages: Vec<CommittedMessage> = vec![];
        let mut current_leaf_index = from_leaf_index;
        while current_leaf_index <= to_checkpoint_index {
            // Relies on the indexer finding this message eventually
            self.db.wait_for_leaf(current_leaf_index).await?;
            let maybe_message = self
                .db
                .message_by_leaf_index(current_leaf_index)?
                .map(CommittedMessage::try_from)
                .transpose()?;
            match maybe_message {
                Some(message) => {
                    if message.message.destination == self.inbox_contracts.inbox.local_domain() {
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
    #[instrument(ret, err, skip(self, messages), fields(messages=messages.len()))]
    async fn submit_checkpoint_and_messages(
        &mut self,
        onchain_checkpoint_index: u32,
        signed_checkpoint_index: u32,
        messages: Vec<CommittedMessage>,
    ) -> Result<u32> {
        // If the checkpoint storage is inconsistent, then this arm won't match
        // and it will cause us to have skipped this message batch
        if let Some(latest_signed_checkpoint) = self
            .multisig_checkpoint_syncer
            .fetch_checkpoint(signed_checkpoint_index)
            .await?
        {
            let batch = MessageBatch::new(
                messages,
                onchain_checkpoint_index,
                latest_signed_checkpoint.checkpoint,
            );

            self.prover_sync.update_from_batch(&batch)?;
            match self
                .inbox_contracts
                .validator_manager
                .submit_checkpoint(&latest_signed_checkpoint)
                .await
            {
                Ok(_) => (),
                Err(err) => {
                    error!(checkpoint=?latest_signed_checkpoint, err=?err, "Checkpoint could not be submitted on-chain");
                    // Ignore errors as to not fail the process and just retry after some sleep
                    sleep(Duration::from_secs(self.submission_latency)).await;
                    return Ok(onchain_checkpoint_index);
                }
            }

            self.inbox_checkpoint_gauge
                .set(latest_signed_checkpoint.checkpoint.index as i64);

            if self.immediate_message_processing {
                // TODO: sign in parallel
                for message in &batch.messages {
                    match self.prover_sync.get_proof(message.leaf_index) {
                        Ok(proof) => {
                            // Ignore errors and expect the lagged message processor to retry
                            match self
                                .inbox_contracts
                                .inbox
                                .process(&message.message, &proof)
                                .await
                            {
                                Ok(outcome) => {
                                    info!(txHash=?outcome.txid, leaf_index=message.leaf_index, "CheckpointRelayer processed message");
                                    self.relayer_processed_gauge.set(message.leaf_index as i64);
                                }
                                Err(error) => {
                                    error!(error=?error, leaf_index=message.leaf_index, "CheckpointRelayer encountered error while processing message, ignoring")
                                }
                            }
                        }
                        Err(err) => {
                            error!(error=?err, "Checkpoint relayer was unable to fetch proof for message processing")
                        }
                    }
                }
            }

            // Sleep latency period after submission
            sleep(Duration::from_secs(self.submission_latency)).await;
            Ok(latest_signed_checkpoint.checkpoint.index)
        } else {
            Ok(onchain_checkpoint_index)
        }
    }

    #[instrument(ret, err, skip(self), fields(inbox_name=self.inbox_contracts.inbox.name()), level = "info")]
    async fn main_loop(mut self) -> Result<()> {
        let latest_inbox_checkpoint = self.inbox_contracts.inbox.latest_checkpoint(None).await?;
        let mut onchain_checkpoint_index = latest_inbox_checkpoint.index;
        self.inbox_checkpoint_gauge
            .set(onchain_checkpoint_index as i64);
        let mut next_inbox_leaf_index = if onchain_checkpoint_index == 0 {
            0
        } else {
            onchain_checkpoint_index + 1
        };

        info!(
            onchain_checkpoint_index = onchain_checkpoint_index,
            "Starting CheckpointRelayer"
        );

        loop {
            sleep(Duration::from_secs(self.polling_interval)).await;

            if let Some(signed_checkpoint_index) =
                self.multisig_checkpoint_syncer.latest_index().await?
            {
                self.signed_checkpoint_gauge
                    .set(signed_checkpoint_index as i64);
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
                        next_inbox_leaf_index = signed_checkpoint_index + 1;
                        debug!("New checkpoint does not include messages for inbox")
                    }
                    Some(messages) => {
                        next_inbox_leaf_index = signed_checkpoint_index + 1;
                        debug!(
                            len = messages.len(),
                            "Signed checkpoint allows for processing of new messages"
                        );

                        onchain_checkpoint_index = self
                            .submit_checkpoint_and_messages(
                                onchain_checkpoint_index,
                                signed_checkpoint_index,
                                messages,
                            )
                            .await?;
                    }
                }
            }
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("CheckpointRelayer");
        tokio::spawn(async move { self.main_loop().await }).instrument(span)
    }
}
