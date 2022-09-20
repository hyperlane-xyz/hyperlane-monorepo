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

use crate::{merkle_tree_builder::MerkleTreeBuilder, settings::matching_list::MatchingList};

use super::SubmitMessageArgs;

#[derive(Debug)]
pub(crate) struct MessageProcessor {
    db: AbacusDB,
    inbox_contracts: InboxContracts,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    metrics: MessageProcessorMetrics,
    tx_msg: mpsc::UnboundedSender<SubmitMessageArgs>,
    ckpt_rx: watch::Receiver<Option<MultisigSignedCheckpoint>>,
    prover_sync: MerkleTreeBuilder,
    message_leaf_index: u32,
}

impl MessageProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        db: AbacusDB,
        inbox_contracts: InboxContracts,
        whitelist: Arc<MatchingList>,
        blacklist: Arc<MatchingList>,
        metrics: MessageProcessorMetrics,
        tx_msg: mpsc::UnboundedSender<SubmitMessageArgs>,
        ckpt_rx: watch::Receiver<Option<MultisigSignedCheckpoint>>,
    ) -> Self {
        Self {
            db: db.clone(),
            inbox_contracts,
            whitelist,
            blacklist,
            metrics,
            tx_msg,
            ckpt_rx,
            prover_sync: MerkleTreeBuilder::new(db),
            message_leaf_index: 0,
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MessageProcessor");
        tokio::spawn(async move { self.main_loop().await }).instrument(span)
    }

    #[instrument(ret, err, skip(self), fields(inbox_name=self.inbox_contracts.inbox.chain_name(), local_domain=?self.inbox_contracts.inbox.local_domain()), level = "info")]
    async fn main_loop(mut self) -> Result<()> {
        // Ensure that there is at least one valid, known checkpoint before starting
        // work loop.
        loop {
            self.ckpt_rx.changed().await?;
            if self.ckpt_rx.borrow().clone().is_some() {
                break;
            }
        }
        // Forever, scan AbacusDB looking for new messages to send. When criteria are
        // satisfied or the message is disqualified, push the message onto
        // self.tx_msg and then continue the scan at the next outbox highest
        // leaf index.
        loop {
            self.tick().await?;
        }
    }

    /// One round of processing, extracted from infinite work loop for
    /// testing purposes.
    async fn tick(&mut self) -> Result<()> {
        self.metrics
            .processor_loop_gauge
            .set(self.message_leaf_index as i64);

        // Scan until we find next index without delivery confirmation.
        if self
            .db
            .retrieve_leaf_processing_status(self.message_leaf_index)?
            .is_some()
        {
            debug!(
                inbox_name=?self.inbox_contracts.inbox.chain_name(),
                local_domain=?self.inbox_contracts.inbox.local_domain(),
                idx=?self.message_leaf_index,
                "Skipping since message_index already in DB");
            self.message_leaf_index += 1;
            return Ok(());
        }
        let message = if let Some(msg) = self
            .db
            .message_by_leaf_index(self.message_leaf_index)?
            .map(CommittedMessage::try_from)
            .transpose()?
        {
            debug!(msg=?msg, "Working on msg");
            msg
        } else {
            debug!(
                "Leaf in db without message idx: {}",
                self.message_leaf_index
            );
            // Not clear what the best thing to do here is, but there is seemingly an
            // existing race wherein an indexer might non-atomically write leaf
            // info to rocksdb across a few records, so we might see the leaf
            // status above, but not the message contents here.  For now,
            // optimistically yield and then re-enter the loop in hopes that the
            // DB is now coherent. TODO(webbhorn): Why can't we yield here
            // instead of sleep?
            tokio::time::sleep(Duration::from_secs(1)).await;
            return Ok(());
        };

        // Skip if for different inbox.
        if message.message.destination != self.inbox_contracts.inbox.local_domain() {
            debug!(
                inbox_name=?self.inbox_contracts.inbox.chain_name(),
                local_domain=?self.inbox_contracts.inbox.local_domain(),
                dst=?message.message.destination,
                msg=?message,
                "Message not for local domain, skipping idx {}", self.message_leaf_index);
            self.message_leaf_index += 1;
            return Ok(());
        }

        // Skip if not whitelisted.
        if !self.whitelist.msg_matches(&message.message, true) {
            debug!(
                inbox_name=?self.inbox_contracts.inbox.chain_name(),
                local_domain=?self.inbox_contracts.inbox.local_domain(),
                dst=?message.message.destination,
                whitelist=?self.whitelist,
                msg=?message,
                "Message not whitelisted, skipping idx {}", self.message_leaf_index);
            self.message_leaf_index += 1;
            return Ok(());
        }

        // skip if the message is blacklisted
        if self.blacklist.msg_matches(&message.message, false) {
            debug!(
                inbox_name=?self.inbox_contracts.inbox.chain_name(),
                local_domain=?self.inbox_contracts.inbox.local_domain(),
                dst=?message.message.destination,
                blacklist=?self.blacklist,
                msg=?message,
                "Message blacklisted, skipping idx {}", self.message_leaf_index);
            self.message_leaf_index += 1;
            return Ok(());
        }

        // If validator hasn't published checkpoint covering self.message_leaf_index
        // yet, wait until it has, before forwarding the message to the
        // submitter channel.
        let mut ckpt;
        loop {
            ckpt = self.ckpt_rx.borrow().clone();
            match &ckpt {
                Some(ckpt) if ckpt.checkpoint.index >= self.message_leaf_index => {
                    break;
                }
                _ => {
                    self.ckpt_rx.changed().await?;
                }
            }
        }
        let checkpoint = ckpt.unwrap();
        assert!(checkpoint.checkpoint.index >= self.message_leaf_index);

        // Include proof against checkpoint for message in the args provided to the
        // submitter.
        if checkpoint.checkpoint.index >= self.prover_sync.count() {
            self.prover_sync
                .update_to_checkpoint(&checkpoint.checkpoint)
                .await?;
        }
        assert_eq!(checkpoint.checkpoint.index + 1, self.prover_sync.count());
        let proof = self.prover_sync.get_proof(self.message_leaf_index)?;

        if self
            .db
            .leaf_by_leaf_index(self.message_leaf_index)?
            .is_some()
        {
            debug!(
                "Sending message at idx {} to submitter",
                self.message_leaf_index
            );
            // Finally, build the submit arg and dispatch it to the submitter.
            let submit_args = SubmitMessageArgs::new(
                self.message_leaf_index,
                message,
                checkpoint,
                proof,
                Instant::now(),
            );
            self.tx_msg.send(submit_args)?;
            self.message_leaf_index += 1;
        } else {
            warn!(
                idx=self.message_leaf_index,
                inbox_name=?self.inbox_contracts.inbox.chain_name(),
                "Unexpected missing leaf_by_leaf_index");
        }
        Ok(())
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
}
