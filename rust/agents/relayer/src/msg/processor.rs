use std::{sync::Arc, time::Duration};

use eyre::Result;
use prometheus::IntGauge;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::Instant,
};
use tracing::{debug, info_span, instrument, instrument::Instrumented, warn, Instrument};

use abacus_base::{CoreMetrics, InboxContracts};
use abacus_core::{
    db::AbacusDB, AbacusCommon, AbacusContract, CommittedMessage, MultisigSignedCheckpoint,
};

use crate::{merkle_tree_builder::MerkleTreeBuilder, settings::whitelist::Whitelist};

use super::SubmitMessageArgs;

#[derive(Debug)]
pub(crate) struct MessageProcessor {
    outbox_db: AbacusDB,
    inbox_contracts: InboxContracts,
    whitelist: Arc<Whitelist>,
    tx_msg: mpsc::UnboundedSender<SubmitMessageArgs>,
    checkpoints: watch::Receiver<Option<MultisigSignedCheckpoint>>,
    prover_sync: MerkleTreeBuilder,
    metrics: MessageProcessorMetrics,
}

impl MessageProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        outbox_db: AbacusDB,
        inbox_contracts: InboxContracts,
        whitelist: Arc<Whitelist>,
        send_messages: mpsc::UnboundedSender<SubmitMessageArgs>,
        checkpoints: watch::Receiver<Option<MultisigSignedCheckpoint>>,
        metrics: MessageProcessorMetrics,
    ) -> Self {
        Self {
            outbox_db: outbox_db.clone(),
            inbox_contracts,
            whitelist,
            tx_msg: send_messages,
            checkpoints,
            prover_sync: MerkleTreeBuilder::new(outbox_db),
            metrics,
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.main_loop().await })
            .instrument(info_span!("MessageProcessor"))
    }

    #[instrument(ret, err, skip(self),
        fields(
            inbox_name=self.inbox_contracts.inbox.chain_name(),
            local_domain=?self.inbox_contracts.inbox.local_domain()),
        level = "info"
    )]
    async fn main_loop(mut self) -> Result<()> {
        loop {
            self.checkpoints.changed().await?;
            if self.checkpoints.borrow().clone().is_some() {
                break;
            }
        }

        let mut i = 0u32;
        loop {
            i = self.tick(&i).await?;
        }
    }

    /// One round of processing, extracted from infinite work loop for testing purposes.
    #[instrument(
        skip(self),
        fields(inbox_name=self.inbox_contracts.inbox.chain_name()),
        level="debug")
    ]
    async fn tick(&mut self, current_index: &u32) -> Result<u32> {
        self.metrics.update_current_index(current_index);

        // TODO(webbhorn): Name in a fn like "delivery_already_recorded(*current_index)"
        if self
            .outbox_db
            .retrieve_leaf_processing_status(*current_index)?
            .is_some()
        {
            return Ok(current_index + 1);
        }

        // TODO(webbhorn): Introduce the moral equivalent of
        // self.db.wait_for_message_by_leaf_index(current_index) and avoid the weird control flow?
        let message = if let Some(committed_message) = self
            .outbox_db
            .message_by_leaf_index(*current_index)?
            .map(CommittedMessage::try_from)
            .transpose()?
        {
            committed_message
        } else {
            debug!("Leaf in db without message idx: {}", current_index);
            // Not clear what the best thing to do here is, but there is seemingly an existing
            // race wherein an indexer might non-atomically write leaf info to rocksdb across a
            // few records, so we might see the leaf status above, but not the message contents
            // here.  For now, optimistically yield and then re-enter the loop in hopes that
            // the DB is now coherent.
            // TODO(webbhorn): Why can't we yield here instead of sleep? Feels wrong / buggy..
            tokio::time::sleep(Duration::from_secs(1)).await;
            return Ok(*current_index);
        };

        // Skip if for different inbox.
        if message.message.destination != self.inbox_contracts.inbox.local_domain() {
            debug!(
                inbox_name=?self.inbox_contracts.inbox.chain_name(),
                local_domain=?self.inbox_contracts.inbox.local_domain(),
                dst=?message.message.destination,
                msg=?message,
                "Message not for local domain, skipping idx {}", current_index);
            return Ok(current_index + 1);
        }

        // Skip if not whitelisted.
        if !self.whitelist.msg_matches(&message.message) {
            debug!(
                inbox_name=?self.inbox_contracts.inbox.chain_name(),
                local_domain=?self.inbox_contracts.inbox.local_domain(),
                dst=?message.message.destination,
                whitelist=?self.whitelist,
                msg=?message,
                "Message not whitelisted, skipping idx {}", current_index);
            return Ok(current_index + 1);
        }

        // If validator hasn't published checkpoint covering self.message_leaf_index yet, wait
        // until it has and we've seen a quorum, before forwarding the message to the submitter.
        //
        // TODO(webbhorn): Extract this into a wait loop function with readable name?
        let mut checkpoint;
        loop {
            checkpoint = self.checkpoints.borrow().clone();
            match &checkpoint {
                Some(c) if c.checkpoint.index >= *current_index => {
                    break;
                }
                _ => self.checkpoints.changed().await?,
            }
        }
        let checkpoint = checkpoint.unwrap();
        assert!(checkpoint.checkpoint.index >= *current_index);

        // Include proof against checkpoint for message in the args provided to the submitter.
        // TODO(webbhorn): Is this the right comparison to be making? The invariant for
        // prover_sync is that count() points to the first unoccupied index. The prover will
        // fail to generate a proof if the requested index >= its count, since in that case it
        // refers to an unoccupied index.  However, I don't think we even have to make this
        // check explicitly since update_to_checkpoint will do the right thing if the
        // prover_syncer is already caught-up.
        if checkpoint.checkpoint.index >= self.prover_sync.count() {
            self.prover_sync
                .update_to_checkpoint(&checkpoint.checkpoint)
                .await?;
        }
        // TODO(webbhorn): This feels like a flimsy assertion... why shouldn't the prover_sync
        // be permitted to update beyond index+1 after a call to update_to_checkpoint?
        assert_eq!(checkpoint.checkpoint.index + 1, self.prover_sync.count());
        let proof = self.prover_sync.get_proof(*current_index)?;

        // Unexpected, but wait a bit and try again on `current_message_leaf_index` next tick.
        // TODO(webbhorn): Might we be better served here to drop into the moral equivalent of
        // AbacusDB::wait_for_leaf rather than this indirect control flow logic triggered by an
        // early-return? If so, introduce a self.wait_for_leaf_by_index() or whatever the equiv is.
        if self.outbox_db.leaf_by_leaf_index(*current_index)?.is_none() {
            warn!(
                idx=current_index,
                inbox_name=?self.inbox_contracts.inbox.chain_name(),
                "Unexpected missing leaf_by_leaf_index");
            return Ok(*current_index);
        }

        let submit_args = SubmitMessageArgs::new(
            *current_index,
            message,
            checkpoint,
            proof,
            // TODO(webbhorn): Never trusted this for second-denominated intervals to begin
            // with, but given that the docs continue to say that won't work and we see
            // negative interval values in monitoring, seems like time to actually fix it.
            Instant::now(),
        );
        self.tx_msg.send(submit_args)?;

        Ok(*current_index + 1)
    }
}

#[derive(Debug)]
pub(crate) struct MessageProcessorMetrics {
    processor_loop_gauge: IntGauge,
}

impl MessageProcessorMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str, inbox_chain: &str) -> Self {
        Self {
            processor_loop_gauge: metrics.last_known_message_leaf_index().with_label_values(&[
                "processor_loop",
                outbox_chain,
                inbox_chain,
            ]),
        }
    }

    fn update_current_index(&self, new_index: &u32) {
        self.processor_loop_gauge.set(*new_index as i64);
    }
}
