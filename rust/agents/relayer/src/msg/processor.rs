use std::{collections::HashMap, sync::Arc, time::Duration};

use eyre::Result;
use prometheus::IntGauge;
use tokio::{
    sync::{mpsc::UnboundedSender, RwLock},
    task::JoinHandle,
};
use tracing::{debug, error, info_span, instrument, instrument::Instrumented, Instrument};

use hyperlane_base::CoreMetrics;
use hyperlane_core::{db::HyperlaneDB, HyperlaneDomain, HyperlaneMessage};

use crate::{merkle_tree_builder::MerkleTreeBuilder, settings::matching_list::MatchingList};

use super::SubmitMessageArgs;

#[derive(Debug)]
pub(crate) struct MessageProcessor {
    db: HyperlaneDB,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    metrics: MessageProcessorMetrics,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    message_nonce: u32,
    send_channels: HashMap<u32, UnboundedSender<SubmitMessageArgs>>,
}

impl MessageProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        db: HyperlaneDB,
        whitelist: Arc<MatchingList>,
        blacklist: Arc<MatchingList>,
        metrics: MessageProcessorMetrics,
        prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
        send_channels: HashMap<u32, UnboundedSender<SubmitMessageArgs>>,
    ) -> Self {
        Self {
            db,
            whitelist,
            blacklist,
            metrics,
            prover_sync,
            send_channels,
            message_nonce: 0,
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MessageProcessor");
        tokio::spawn(async move { self.main_loop().await }).instrument(span)
    }

    #[instrument(ret, err, skip(self), level = "info")]
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
        // Scan until we find next nonce without delivery confirmation.
        if self
            .db
            .retrieve_message_processed(self.message_nonce)?
            .is_some()
        {
            debug!(
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
        self.metrics
            .get(message.destination)
            .unwrap()
            .set(self.message_nonce as i64);

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

        // Feed the message to the prover sync
        self.prover_sync
            .write()
            .await
            .update_to_index(message.nonce)
            .await?;

        if self.db.message_id_by_nonce(self.message_nonce)?.is_some() {
            debug!(
                id=?message.id(),
                nonce=message.nonce,
                "Sending message to submitter"
            );
            // Finally, build the submit arg and dispatch it to the submitter.
            let submit_args = SubmitMessageArgs::new(message.clone());
            if let Some(send_channel) = self.send_channels.get(&message.destination) {
                send_channel.send(submit_args)?;
            } else {
                debug!(
                    id=?message.id(),
                    destination=message.destination,
                    nonce=message.nonce,
                    "Message destined for unknown domain, skipping");
            }
            self.message_nonce += 1;
        } else {
            error!(
                nonce = self.message_nonce,
                "Unexpected missing message_id_by_nonce"
            );
        }
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct MessageProcessorMetrics {
    last_known_message_nonce_gauges: HashMap<u32, IntGauge>,
}

impl MessageProcessorMetrics {
    pub fn new(
        metrics: &CoreMetrics,
        origin: &HyperlaneDomain,
        destinations: Vec<&HyperlaneDomain>,
    ) -> Self {
        let mut gauges: HashMap<u32, IntGauge> = HashMap::new();
        for destination in destinations {
            gauges.insert(
                destination.id(),
                metrics.last_known_message_nonce().with_label_values(&[
                    "processor_loop",
                    origin.name(),
                    destination.name(),
                ]),
            );
        }
        Self {
            last_known_message_nonce_gauges: gauges,
        }
    }

    pub fn get(&self, destination: u32) -> Option<&IntGauge> {
        self.last_known_message_nonce_gauges.get(&destination)
    }
    /*
    pub fn new(metrics: &CoreMetrics, origin: &HyperlaneDomain, destination: &HyperlaneDomain) -> Self {
        Self {
            processor_loop_gauge: metrics.last_known_message_nonce().with_label_values(&[
                "processor_loop",
                origin.name(),
                destination.name(),
            ]),
        }
    } */
}
