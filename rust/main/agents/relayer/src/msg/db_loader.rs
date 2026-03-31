use std::{
    cmp::max,
    collections::HashMap,
    fmt::{Debug, Formatter},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use derive_new::new;
use ethers::utils::hex;
use eyre::Result;
use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    CoreMetrics,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneMessage, QueueOperation};
use prometheus::IntGauge;
use tokio::sync::mpsc::UnboundedSender;
use tracing::{debug, instrument, trace};

use super::{blacklist::AddressBlacklist, metadata::AppContextClassifier, pending_message::*};
use crate::{db_loader::DbLoaderExt, settings::matching_list::MatchingList};

/// Finds unprocessed messages from an origin and submits then through a channel
/// for to the appropriate destination.
#[allow(clippy::too_many_arguments)]
pub struct MessageDbLoader {
    /// A matching list of messages that should be whitelisted.
    message_whitelist: Arc<MatchingList>,
    /// A matching list of messages that should be blacklisted.
    message_blacklist: Arc<MatchingList>,
    /// Addresses that messages may not interact with.
    address_blacklist: Arc<AddressBlacklist>,
    metrics: MessageDbLoaderMetrics,
    /// channel for each destination chain to send operations (i.e. message
    /// submissions) to
    send_channels: HashMap<u32, UnboundedSender<QueueOperation>>,
    /// Needed context to send a message for each destination chain
    destination_ctxs: HashMap<u32, Arc<MessageContext>>,
    metric_app_contexts: Arc<Vec<(MatchingList, String)>>,
    nonce_iterator: ForwardBackwardIterator,
    max_retries: u32,
}

#[derive(Debug)]
struct ForwardBackwardIterator {
    low_nonce_iter: DirectionalNonceIterator,
    high_nonce_iter: DirectionalNonceIterator,
    // here for debugging purposes
    _domain: String,
}

impl ForwardBackwardIterator {
    #[instrument(skip(db), ret)]
    fn new(db: Arc<dyn HyperlaneDb>) -> Self {
        let high_nonce = db.retrieve_highest_seen_message_nonce().ok().flatten();
        let domain = db.domain().name().to_owned();
        let high_nonce_iter = DirectionalNonceIterator::new(
            // If the high nonce is None, we start from the beginning
            high_nonce.unwrap_or_default().into(),
            NonceDirection::High,
            db.clone(),
            domain.clone(),
        );
        let mut low_nonce_iter =
            DirectionalNonceIterator::new(high_nonce, NonceDirection::Low, db, domain.clone());
        // Decrement the low nonce to avoid processing the same message twice, which causes double counts in metrics
        low_nonce_iter.iterate();
        debug!(
            ?low_nonce_iter,
            ?high_nonce_iter,
            ?domain,
            "Initialized ForwardBackwardIterator"
        );
        Self {
            low_nonce_iter,
            high_nonce_iter,
            _domain: domain,
        }
    }

    async fn try_get_next_message(
        &mut self,
        metrics: &MessageDbLoaderMetrics,
    ) -> Result<Option<HyperlaneMessage>> {
        loop {
            let high_nonce_message_status = self.high_nonce_iter.try_get_next_nonce(metrics)?;
            let low_nonce_message_status = self.low_nonce_iter.try_get_next_nonce(metrics)?;

            match (high_nonce_message_status, low_nonce_message_status) {
                // Always prioritize advancing the high nonce iterator, as
                // we have a preference for higher nonces
                (MessageStatus::Processed, _) => {
                    self.high_nonce_iter.iterate();
                }
                (MessageStatus::Processable(high_nonce_message), _) => {
                    self.high_nonce_iter.iterate();
                    return Ok(Some(high_nonce_message));
                }

                // Low nonce messages are only processed if the high nonce iterator
                // can't make any progress
                (_, MessageStatus::Processed) => {
                    self.low_nonce_iter.iterate();
                }
                (_, MessageStatus::Processable(low_nonce_message)) => {
                    self.low_nonce_iter.iterate();
                    return Ok(Some(low_nonce_message));
                }

                // If both iterators give us unindexed messages, there are no messages at the moment
                (MessageStatus::Unindexed, MessageStatus::Unindexed) => return Ok(None),
            }
            // This loop may iterate through millions of processed messages, blocking the runtime.
            // So, to avoid starving other futures in this task, yield to the runtime
            // on each iteration
            tokio::task::yield_now().await;
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
enum NonceDirection {
    #[default]
    High,
    Low,
}

#[derive(new)]
struct DirectionalNonceIterator {
    nonce: Option<u32>,
    direction: NonceDirection,
    db: Arc<dyn HyperlaneDb>,
    domain_name: String,
}

impl Debug for DirectionalNonceIterator {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "DirectionalNonceIterator {{ nonce: {:?}, direction: {:?}, domain: {:?} }}",
            self.nonce, self.direction, self.domain_name
        )
    }
}

impl DirectionalNonceIterator {
    #[instrument]
    fn iterate(&mut self) {
        match self.direction {
            NonceDirection::High => {
                self.nonce = self.nonce.map(|n| n.saturating_add(1));
                debug!(?self, "Iterating high nonce");
            }
            NonceDirection::Low => {
                if let Some(nonce) = self.nonce {
                    // once the message with nonce zero is processed, we should stop going backwards
                    self.nonce = nonce.checked_sub(1);
                }
            }
        }
    }

    fn try_get_next_nonce(
        &self,
        metrics: &MessageDbLoaderMetrics,
    ) -> Result<MessageStatus<HyperlaneMessage>> {
        if let Some(message) = self.indexed_message_with_nonce()? {
            Self::update_max_nonce_gauge(&message, metrics);
            if !self.is_message_processed()? {
                trace!(hyp_message=?message, iterator=?self, "Found processable message");
                return Ok(MessageStatus::Processable(message));
            } else {
                return Ok(MessageStatus::Processed);
            }
        }
        Ok(MessageStatus::Unindexed)
    }

    fn update_max_nonce_gauge(message: &HyperlaneMessage, metrics: &MessageDbLoaderMetrics) {
        let current_max = metrics.last_known_message_nonce_gauge.get();
        metrics
            .last_known_message_nonce_gauge
            .set(max(current_max, message.nonce as i64));
    }

    fn indexed_message_with_nonce(&self) -> Result<Option<HyperlaneMessage>> {
        match self.nonce {
            Some(nonce) => {
                let msg = self.db.retrieve_message_by_nonce(nonce)?;
                Ok(msg)
            }
            None => Ok(None),
        }
    }

    fn is_message_processed(&self) -> Result<bool> {
        let Some(nonce) = self.nonce else {
            return Ok(false);
        };
        let processed = self
            .db
            .retrieve_processed_by_nonce(&nonce)?
            .unwrap_or(false);
        if processed {
            trace!(
                nonce,
                domain = self.db.domain().name(),
                "Message already marked as processed in DB"
            );
        }
        Ok(processed)
    }
}

#[derive(Debug)]
enum MessageStatus<T> {
    /// The message wasn't indexed yet so can't be processed.
    Unindexed,
    // The message was indexed and is ready to be processed.
    Processable(T),
    // The message was indexed and already processed.
    Processed,
}

impl Debug for MessageDbLoader {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MessageDbLoader {{ message_whitelist: {:?}, message_blacklist: {:?}, address_blacklist: {:?}, nonce_iterator: {:?}}}",
            self.message_whitelist, self.message_blacklist, self.address_blacklist, self.nonce_iterator
        )
    }
}

#[async_trait]
impl DbLoaderExt for MessageDbLoader {
    /// The name of this db_loader
    fn name(&self) -> String {
        format!("db_loader::message::{}", self.domain().name())
    }

    /// The domain this db_loader is getting messages from.
    fn domain(&self) -> &HyperlaneDomain {
        self.nonce_iterator.high_nonce_iter.db.domain()
    }

    /// One round of processing, extracted from infinite work loop for
    /// testing purposes.
    async fn tick(&mut self) -> Result<()> {
        // Forever, scan HyperlaneRocksDB looking for new messages to send. When criteria are
        // satisfied or the message is disqualified, push the message onto
        // self.tx_msg and then continue the scan at the next highest
        // nonce.
        // Scan until we find next nonce without delivery confirmation.
        if let Some(msg) = self.try_get_unprocessed_message().await? {
            trace!(
                ?msg,
                cursor = ?self.nonce_iterator,
                "db_loader working on message"
            );
            let destination = msg.destination;

            // Skip if not whitelisted.
            if !self.message_whitelist.msg_matches(&msg, true) {
                debug!(?msg, "Message not whitelisted, skipping");
                return Ok(());
            }

            // Skip if the message is blacklisted
            if self.message_blacklist.msg_matches(&msg, false) {
                debug!(?msg, "Message blacklisted, skipping");
                return Ok(());
            }

            // Skip if the message involves a blacklisted address
            if let Some(blacklisted_address) = self.address_blacklist.find_blacklisted_address(&msg)
            {
                debug!(
                    ?msg,
                    blacklisted_address = hex::encode(blacklisted_address),
                    "Message involves blacklisted address, skipping"
                );
                return Ok(());
            }

            // Skip if the message is intended for a destination we do not service
            if !self.send_channels.contains_key(&destination) {
                debug!(?msg, "Message destined for unknown domain, skipping");
                return Ok(());
            }

            // Skip if message is intended for a destination we don't have message context for
            let destination_msg_ctx = if let Some(ctx) = self.destination_ctxs.get(&destination) {
                ctx
            } else {
                debug!(
                    ?msg,
                    "Message destined for unknown message context, skipping",
                );
                return Ok(());
            };

            debug!(%msg, "Sending message to submitter");

            let app_context_classifier =
                AppContextClassifier::new(self.metric_app_contexts.clone());

            let app_context = app_context_classifier.get_app_context(&msg).await?;
            // Finally, build the submit arg and dispatch it to the submitter.
            let pending_msg = PendingMessage::maybe_from_persisted_retries(
                msg,
                destination_msg_ctx.clone(),
                app_context,
                self.max_retries,
            );
            if let Some(pending_msg) = pending_msg {
                self.send_channels[&destination].send(Box::new(pending_msg) as QueueOperation)?;
            }
        } else {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Ok(())
    }
}

impl MessageDbLoader {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        db: HyperlaneRocksDB,
        message_whitelist: Arc<MatchingList>,
        message_blacklist: Arc<MatchingList>,
        address_blacklist: Arc<AddressBlacklist>,
        metrics: MessageDbLoaderMetrics,
        send_channels: HashMap<u32, UnboundedSender<QueueOperation>>,
        destination_ctxs: HashMap<u32, Arc<MessageContext>>,
        metric_app_contexts: Arc<Vec<(MatchingList, String)>>,
        max_retries: u32,
    ) -> Self {
        Self {
            message_whitelist,
            message_blacklist,
            address_blacklist,
            metrics,
            send_channels,
            destination_ctxs,
            metric_app_contexts,
            nonce_iterator: ForwardBackwardIterator::new(Arc::new(db) as Arc<dyn HyperlaneDb>),
            max_retries,
        }
    }

    async fn try_get_unprocessed_message(&mut self) -> Result<Option<HyperlaneMessage>> {
        trace!(nonce_iterator=?self.nonce_iterator, "Trying to get the next db_loader message");
        let next_message = self
            .nonce_iterator
            .try_get_next_message(&self.metrics)
            .await?;
        if next_message.is_none() {
            trace!(nonce_iterator=?self.nonce_iterator, "No message found in DB for nonce");
        }
        Ok(next_message)
    }
}

#[derive(Debug)]
pub struct MessageDbLoaderMetrics {
    last_known_message_nonce_gauge: IntGauge,
}

impl MessageDbLoaderMetrics {
    pub fn new(metrics: &CoreMetrics, origin: &HyperlaneDomain) -> Self {
        Self {
            last_known_message_nonce_gauge: metrics
                .last_known_message_nonce()
                .with_label_values(&["db_loader_loop", origin.name()]),
        }
    }
}

#[cfg(test)]
pub mod tests;
