use std::{sync::Arc, time::Duration};

use eyre::Result;
use prometheus::IntGauge;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::Instant,
};
use tracing::{debug, info, info_span, instrument, instrument::Instrumented, warn, Instrument};

use hyperlane_base::{CoreMetrics, CachingMailbox};
use hyperlane_core::{db::HyperlaneDB, HyperlaneChain, MultisigSignedCheckpoint, HyperlaneMessage};

use crate::{merkle_tree_builder::MerkleTreeBuilder, settings::matching_list::MatchingList};

use super::SubmitMessageArgs;

#[derive(Debug)]
pub(crate) struct MessageProcessor {
    db: HyperlaneDB,
    mailbox: CachingMailbox,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    metrics: MessageProcessorMetrics,
    tx_msg: mpsc::UnboundedSender<SubmitMessageArgs>,
    ckpt_rx: watch::Receiver<Option<MultisigSignedCheckpoint>>,
    prover_sync: MerkleTreeBuilder,
    message_nonce: u32,
}

impl MessageProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        db: HyperlaneDB,
        mailbox: CachingMailbox,
        whitelist: Arc<MatchingList>,
        blacklist: Arc<MatchingList>,
        metrics: MessageProcessorMetrics,
        tx_msg: mpsc::UnboundedSender<SubmitMessageArgs>,
        ckpt_rx: watch::Receiver<Option<MultisigSignedCheckpoint>>,
    ) -> Self {
        Self {
            db: db.clone(),
            mailbox,
            whitelist,
            blacklist,
            metrics,
            tx_msg,
            ckpt_rx,
            prover_sync: MerkleTreeBuilder::new(db),
            message_nonce: 0,
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MessageProcessor");
        tokio::spawn(async move { self.main_loop().await }).instrument(span)
    }

    #[instrument(ret, err, skip(self), fields(chain=self.mailbox.chain_name(), domain=?self.mailbox.local_domain()), level = "info")]
    async fn main_loop(mut self) -> Result<()> {
        // Ensure that there is at least one valid, known checkpoint before starting
        // work loop.
        loop {
            self.ckpt_rx.changed().await?;
            if self.ckpt_rx.borrow().clone().is_some() {
                break;
            }
        }
        // Forever, scan HyperlaneDB looking for new messages to send. When criteria are
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
            .set(self.message_nonce as i64);

        // Scan until we find next index without delivery confirmation.
        if self
            .db
            .retrieve_message_processed(self.message_nonce)?
            .is_some()
        {
            debug!(
                chain=?self.mailbox.chain_name(),
                domain=?self.mailbox.local_domain(),
                nonce=?self.message_nonce,
                "Skipping since message_index already in DB");
            self.message_nonce += 1;
            return Ok(());
        }
        let message = if let Some(msg) = self
            .db
            .message_by_nonce(self.message_nonce)?
            .map(HyperlaneMessage::from)
        {
            debug!(msg=?msg, "Working on msg");
            msg
        } else {
            debug!("Leaf in db without message idx: {}", self.message_nonce);
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
        if message.destination != self.mailbox.local_domain() {
            debug!(
                id=?message.id(),
                destination=message.destination,
                nonce=message.nonce,
                "Message destined for other domain, skipping");
            self.message_nonce += 1;
            return Ok(());
        }

        // Skip if not whitelisted.
        if !self.whitelist.msg_matches(&message, true) {
            debug!(
                id=?message.id(),
                destination=message.destination,
                nonce=message.nonce,
                whitelist=?self.whitelist,
                "Message not whitelisted, skipping");
            self.message_nonce += 1;
            return Ok(());
        }

        // Skip if the message is blacklisted
        if self.blacklist.msg_matches(&message, false) {
            debug!(
                id=?message.id(),
                destination=message.destination,
                nonce=message.nonce,
                blacklist=?self.blacklist,
                "Message blacklisted, skipping");
            self.message_nonce += 1;
            return Ok(());
        }

        // If validator hasn't published checkpoint covering self.message_nonce
        // yet, wait until it has, before forwarding the message to the
        // submitter channel.
        let mut ckpt;
        loop {
            ckpt = self.ckpt_rx.borrow().clone();
            match &ckpt {
                Some(ckpt) if ckpt.checkpoint.index >= self.message_nonce => {
                    break;
                }
                _ => {
                    self.ckpt_rx.changed().await?;
                }
            }
        }
        let checkpoint = ckpt.unwrap();
        assert!(checkpoint.checkpoint.index >= self.message_nonce);
        info!(
            id=?message.id(),
            nonce=message.nonce,
            "Found signed checkpoint for message"
        );

        // Include proof against checkpoint for message in the args provided to the
        // submitter.
        if checkpoint.checkpoint.index >= self.prover_sync.count() {
            self.prover_sync
                .update_to_checkpoint(&checkpoint.checkpoint)
                .await?;
        }
        assert_eq!(checkpoint.checkpoint.index + 1, self.prover_sync.count());
        let proof = self.prover_sync.get_proof(self.message_nonce)?;

        if self.db.message_id_by_nonce(self.message_nonce)?.is_some() {
            debug!(
                id=?message.id(),
                nonce=message.nonce,
                "Sending message to submitter"
            );
            // Finally, build the submit arg and dispatch it to the submitter.
            let submit_args = SubmitMessageArgs::new(message, checkpoint, proof, Instant::now());
            self.tx_msg.send(submit_args)?;
            self.message_nonce += 1;
        } else {
            warn!(
                nonce=self.message_nonce,
                chain=?self.mailbox.chain_name(),
                "Unexpected missing message_id_by_nonce");
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct MessageProcessorMetrics {
    processor_loop_gauge: IntGauge,
}

impl MessageProcessorMetrics {
    pub fn new(metrics: &CoreMetrics, origin_chain: &str, destination_chain: &str) -> Self {
        Self {
            processor_loop_gauge: metrics.last_known_message_nonce().with_label_values(&[
                "processor_loop",
                origin_chain,
                destination_chain,
            ]),
        }
    }
}
