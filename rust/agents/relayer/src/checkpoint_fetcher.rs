use std::time::Duration;

use eyre::Result;
use prometheus::{IntGauge, IntGaugeVec};
use tokio::{sync::mpsc::Sender, task::JoinHandle, time::sleep};

use tracing::{debug, info, info_span, instrument, instrument::Instrumented, Instrument};

use abacus_base::{InboxContracts, MultisigCheckpointSyncer, Outboxes};
use abacus_core::{
    db::AbacusDB, AbacusCommon, AbacusContract, CommittedMessage, MultisigSignedCheckpoint,
};

pub(crate) struct CheckpointFetcher {
    polling_interval: u64,
    db: AbacusDB,
    inbox_contracts: InboxContracts,
    multisig_checkpoint_syncer: MultisigCheckpointSyncer,
    signed_checkpoint_sender: Sender<MultisigSignedCheckpoint>,
    signed_checkpoint_gauge: IntGauge,
}

impl CheckpointFetcher {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        outbox: Outboxes,
        polling_interval: u64,
        db: AbacusDB,
        inbox_contracts: InboxContracts,
        multisig_checkpoint_syncer: MultisigCheckpointSyncer,
        signed_checkpoint_sender: Sender<MultisigSignedCheckpoint>,
        leaf_index_gauge: IntGaugeVec,
    ) -> Self {
        let signed_checkpoint_gauge = leaf_index_gauge.with_label_values(&[
            "signed_offchain_checkpoint",
            outbox.chain_name(),
            inbox_contracts.inbox.chain_name(),
        ]);
        Self {
            polling_interval,
            db,
            inbox_contracts,
            multisig_checkpoint_syncer,
            signed_checkpoint_sender,
            signed_checkpoint_gauge,
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

    // Returns the latest signed checkpoint index
    #[instrument(ret, err, skip(self, messages), fields(messages = messages.len()))]
    async fn fetch_and_send_signed_checkpoint(
        &mut self,
        latest_signed_checkpoint_index: u32,
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
            // Send the signed checkpoint to the message processor.
            // Blocks if the receiver's buffer is full.
            self.signed_checkpoint_sender
                .send(latest_signed_checkpoint.clone())
                .await?;

            Ok(latest_signed_checkpoint.checkpoint.index)
        } else {
            Ok(latest_signed_checkpoint_index)
        }
    }

    #[instrument(ret, err, skip(self), fields(inbox_name = self.inbox_contracts.inbox.chain_name()), level = "info")]
    async fn main_loop(mut self) -> Result<()> {
        let mut latest_signed_checkpoint_index = 0;
        let mut next_inbox_leaf_index = 0;

        info!(
            latest_signed_checkpoint_index=?latest_signed_checkpoint_index,
            "Starting CheckpointFetcher"
        );

        loop {
            sleep(Duration::from_secs(self.polling_interval)).await;

            if let Some(signed_checkpoint_index) =
                self.multisig_checkpoint_syncer.latest_index().await?
            {
                self.signed_checkpoint_gauge
                    .set(signed_checkpoint_index as i64);
                if signed_checkpoint_index <= latest_signed_checkpoint_index {
                    debug!(
                        latest = latest_signed_checkpoint_index,
                        signed = signed_checkpoint_index,
                        "Signed checkpoint is less than or equal to latest known checkpoint, continuing"
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

                        latest_signed_checkpoint_index = self
                            .fetch_and_send_signed_checkpoint(
                                latest_signed_checkpoint_index,
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
        let span = info_span!("CheckpointFetcher");
        tokio::spawn(async move { self.main_loop().await }).instrument(span)
    }
}
