use std::{sync::Arc, time::Duration};

use eyre::Result;
use prometheus::IntGauge;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};
use tracing::{debug, info_span, instrument, instrument::Instrumented, warn, Instrument};

use hyperlane_base::{CachingMailbox, CoreMetrics};
use hyperlane_core::{
    db::HyperlaneDB, HyperlaneChain, HyperlaneDomain, HyperlaneMessage,
};

use crate::{merkle_tree_builder::MerkleTreeBuilder, settings::matching_list::MatchingList};

use super::SubmitMessageArgs;

#[derive(Debug)]
pub(crate) struct MessageProcessor {
    db: HyperlaneDB,
    destination_mailbox: CachingMailbox,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    metrics: MessageProcessorMetrics,
    tx_msg: mpsc::UnboundedSender<SubmitMessageArgs>,
    message_nonce: u32,
}

impl MessageProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        db: HyperlaneDB,
        destination_mailbox: CachingMailbox,
        whitelist: Arc<MatchingList>,
        blacklist: Arc<MatchingList>,
        metrics: MessageProcessorMetrics,
        tx_msg: mpsc::UnboundedSender<SubmitMessageArgs>,
    ) -> Self {
        Self {
            db: db.clone(),
            destination_mailbox,
            whitelist,
            blacklist,
            metrics,
            tx_msg,
            message_nonce: 0,
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MessageProcessor");
        tokio::spawn(async move { self.main_loop().await }).instrument(span)
    }

    #[instrument(ret, err, skip(self), fields(domain=%self.destination_mailbox.domain()), level = "info")]
    async fn main_loop(mut self) -> Result<()> {
        // Forever, scan HyperlaneDB looking for new messages to send. When criteria are
        // satisfied or the message is disqualified, push the message onto
        // self.tx_msg and then continue the scan at the next highest
        // nonce.
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

        // Scan until we find next nonce without delivery confirmation.
        if self
            .db
            .retrieve_message_processed(self.message_nonce)?
            .is_some()
        {
            debug!(
                domain=%self.destination_mailbox.domain(),
                nonce=?self.message_nonce,
                "Skipping since message_nonce already in DB");
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
            debug!("Leaf in db without message nonce: {}", self.message_nonce);
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

        // Skip if for different domain.
        if message.destination != self.destination_mailbox.domain().id() {
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

        if self.db.message_id_by_nonce(self.message_nonce)?.is_some() {
            debug!(
                id=?message.id(),
                nonce=message.nonce,
                "Sending message to submitter"
            );
            // Finally, build the submit arg and dispatch it to the submitter.
            let submit_args = SubmitMessageArgs::new(message);
            self.tx_msg.send(submit_args)?;
            self.message_nonce += 1;
        } else {
            warn!(
                nonce=self.message_nonce,
                domain=%self.destination_mailbox.domain(),
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
    pub fn new(
        metrics: &CoreMetrics,
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Self {
        Self {
            processor_loop_gauge: metrics.last_known_message_nonce().with_label_values(&[
                "processor_loop",
                origin.name(),
                destination.name(),
            ]),
        }
    }
}
