use std::fmt::{Debug, Formatter};
use std::{collections::HashMap, sync::Arc, time::Duration};

use derive_new::new;
use eyre::Result;
use prometheus::IntGauge;
use tokio::{
    sync::{mpsc::UnboundedSender, RwLock},
    task::JoinHandle,
};
use tracing::{debug, info_span, instrument, instrument::Instrumented, Instrument};

use hyperlane_base::{db::HyperlaneDB, CoreMetrics};
use hyperlane_core::{HyperlaneDomain, HyperlaneMessage};

use crate::msg::pending_operation::DynPendingOperation;
use crate::{merkle_tree_builder::MerkleTreeBuilder, settings::matching_list::MatchingList};

use super::pending_message::*;

/// Finds unprocessed messages from an origin and submits then through a channel
/// for to the appropriate destination.
#[derive(new)]
pub struct MessageProcessor {
    db: HyperlaneDB,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    metrics: MessageProcessorMetrics,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    /// channel for each destination chain to send operations (i.e. message
    /// submissions) to
    send_channels: HashMap<u32, UnboundedSender<Box<DynPendingOperation>>>,
    /// Needed context to send a message for each destination chain
    destination_ctxs: HashMap<u32, Arc<MessageCtx>>,
    #[new(default)]
    message_nonce: u32,
}

impl Debug for MessageProcessor {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MessageProcessor {{ whitelist: {:?}, blacklist: {:?}, prover_sync: {:?}, message_nonce: {:?} }}",
            self.whitelist,
            self.blacklist,
            self.prover_sync,
            self.message_nonce
        )
    }
}

impl MessageProcessor {
    pub fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
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

    /// Tries to get the next message to process.
    ///
    /// If no message with self.message_nonce is found, returns None.
    /// If the message with self.message_nonce is found and has previously
    /// been marked as processed, increments self.message_nonce and returns
    /// None.
    fn try_get_unprocessed_message(&mut self) -> Result<Option<HyperlaneMessage>> {
        loop {
            // First, see if we can find the message so we can update the gauge.
            if let Some(message) = self.db.message_by_nonce(self.message_nonce)? {
                // Update the latest nonce gauges
                self.metrics
                    .max_last_known_message_nonce_gauge
                    .set(message.nonce as i64);
                if let Some(metrics) = self.metrics.get(message.destination) {
                    metrics.set(message.nonce as i64);
                }

                // If this message has already been processed, on to the next one.
                if self
                    .db
                    .retrieve_message_processed(self.message_nonce)?
                    .is_none()
                {
                    return Ok(Some(message));
                } else {
                    debug!(
                    nonce=?self.message_nonce,
                    "Message already marked as processed in DB");
                    self.message_nonce += 1;
                }
            } else {
                debug!(
                nonce=?self.message_nonce,
                "No message found in DB for nonce");
                return Ok(None);
            }
        }
    }

    /// One round of processing, extracted from infinite work loop for
    /// testing purposes.
    async fn tick(&mut self) -> Result<()> {
        // Scan until we find next nonce without delivery confirmation.
        if let Some(msg) = self.try_get_unprocessed_message()? {
            debug!(?msg, "Processor working on message");
            let destination = msg.destination;

            // Skip if not whitelisted.
            if !self.whitelist.msg_matches(&msg, true) {
                debug!(?msg, whitelist=?self.whitelist, "Message not whitelisted, skipping");
                self.message_nonce += 1;
                return Ok(());
            }

            // Skip if the message is blacklisted
            if self.blacklist.msg_matches(&msg, false) {
                debug!(?msg, blacklist=?self.blacklist, "Message blacklisted, skipping");
                self.message_nonce += 1;
                return Ok(());
            }

            // Skip if the message is intended for a destination we do not service
            if !self.send_channels.contains_key(&destination) {
                debug!(?msg, "Message destined for unknown domain, skipping");
                self.message_nonce += 1;
                return Ok(());
            }

            // Feed the message to the prover sync
            self.prover_sync
                .write()
                .await
                .update_to_index(msg.nonce)
                .await?;

            debug!(%msg, "Sending message to submitter");

            // Finally, build the submit arg and dispatch it to the submitter.
            let pending_msg = PendingMessage::new(msg, self.destination_ctxs[&destination].clone());
            self.send_channels[&destination].send(Box::new(pending_msg.into()))?;
            self.message_nonce += 1;
        } else {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct MessageProcessorMetrics {
    max_last_known_message_nonce_gauge: IntGauge,
    last_known_message_nonce_gauges: HashMap<u32, IntGauge>,
}

impl MessageProcessorMetrics {
    pub fn new<'a>(
        metrics: &CoreMetrics,
        origin: &HyperlaneDomain,
        destinations: impl Iterator<Item = &'a HyperlaneDomain>,
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
            max_last_known_message_nonce_gauge: metrics
                .last_known_message_nonce()
                .with_label_values(&["processor_loop", origin.name(), "any"]),
            last_known_message_nonce_gauges: gauges,
        }
    }

    fn get(&self, destination: u32) -> Option<&IntGauge> {
        self.last_known_message_nonce_gauges.get(&destination)
    }
}
