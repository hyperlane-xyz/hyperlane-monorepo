use std::{
    cmp::max,
    collections::HashMap,
    fmt::{Debug, Formatter},
    sync::Arc,
    time::Duration,
};

use tokio::sync::RwLock;

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
use crate::{
    db_loader::DbLoaderExt, relayer::DynamicMessageContexts, settings::matching_list::MatchingList,
};

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
    /// submissions) to. Wrapped in Arc<RwLock<...>> to allow dynamic updates
    /// when new destinations become ready during incremental startup.
    send_channels: Arc<RwLock<HashMap<u32, UnboundedSender<QueueOperation>>>>,
    /// The origin domain this db_loader is processing messages from.
    origin_domain: HyperlaneDomain,
    /// Message contexts for all (origin, destination) pairs. Used to look up
    /// the context for messages dynamically, allowing new destinations to be
    /// added during incremental startup.
    msg_ctxs: DynamicMessageContexts,
    metric_app_contexts: Vec<(MatchingList, String)>,
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
        let current_max = metrics.max_last_known_message_nonce_gauge.get();
        metrics
            .max_last_known_message_nonce_gauge
            .set(max(current_max, message.nonce as i64));
        if let Some(metrics) = metrics.get(message.destination) {
            metrics.set(message.nonce as i64);
        }
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

            // Wait for the destination to become ready (during incremental startup, destinations
            // may not be ready when messages are first indexed). We hold onto the message and
            // wait rather than skipping, because the iterator has already advanced past this
            // message and we can't go back to it.
            const MAX_DESTINATION_WAIT_SECS: u64 = 300; // 5 minutes max wait
            const DESTINATION_CHECK_INTERVAL_MS: u64 = 500;
            let max_attempts = (MAX_DESTINATION_WAIT_SECS * 1000) / DESTINATION_CHECK_INTERVAL_MS;

            let mut attempts: u64 = 0;
            loop {
                // Read from RwLock to get current send_channels (may be updated during incremental startup)
                let send_channels_read = self.send_channels.read().await;

                if send_channels_read.contains_key(&destination) {
                    // Destination is ready, continue processing
                    break;
                }

                drop(send_channels_read);
                attempts = attempts.wrapping_add(1);

                if attempts >= max_attempts {
                    debug!(
                        ?msg,
                        "Message destined for unknown domain after max wait, skipping"
                    );
                    return Ok(());
                }

                if attempts == 1 {
                    debug!(
                        ?msg,
                        "Message destined for unknown domain, waiting for destination to become ready"
                    );
                }

                tokio::time::sleep(Duration::from_millis(DESTINATION_CHECK_INTERVAL_MS)).await;
            }

            // Re-acquire the lock after waiting
            let send_channels_read = self.send_channels.read().await;

            // Read from msg_ctxs to get the message context dynamically.
            // This allows new destinations to be seen during incremental startup.
            // Wait for the context to become available too.
            let mut attempts: u64 = 0;
            let destination_msg_ctx = loop {
                let msg_ctxs_read = self.msg_ctxs.read().await;

                // Find the message context for this (origin, destination) pair by iterating
                // through the map. We match on origin_domain and destination ID.
                let ctx = msg_ctxs_read
                    .iter()
                    .find(|(key, _)| {
                        key.origin == self.origin_domain && key.destination.id() == destination
                    })
                    .map(|(_, ctx)| ctx.clone());

                if let Some(ctx) = ctx {
                    break ctx;
                }

                drop(msg_ctxs_read);
                attempts = attempts.wrapping_add(1);

                if attempts >= max_attempts {
                    debug!(
                        ?msg,
                        "Message destined for unknown message context after max wait, skipping",
                    );
                    return Ok(());
                }

                if attempts == 1 {
                    debug!(
                        ?msg,
                        "Message context not ready, waiting for destination to be fully initialized"
                    );
                }

                tokio::time::sleep(Duration::from_millis(DESTINATION_CHECK_INTERVAL_MS)).await;
            };

            debug!(%msg, "Sending message to submitter");

            let app_context_classifier =
                AppContextClassifier::new(self.metric_app_contexts.clone());

            let app_context = app_context_classifier.get_app_context(&msg).await?;
            // Finally, build the submit arg and dispatch it to the submitter.
            let pending_msg = PendingMessage::maybe_from_persisted_retries(
                msg,
                destination_msg_ctx,
                app_context,
                self.max_retries,
            );
            if let Some(pending_msg) = pending_msg {
                send_channels_read[&destination].send(Box::new(pending_msg) as QueueOperation)?;
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
        send_channels: Arc<RwLock<HashMap<u32, UnboundedSender<QueueOperation>>>>,
        origin_domain: HyperlaneDomain,
        msg_ctxs: DynamicMessageContexts,
        metric_app_contexts: Vec<(MatchingList, String)>,
        max_retries: u32,
    ) -> Self {
        Self {
            message_whitelist,
            message_blacklist,
            address_blacklist,
            metrics,
            send_channels,
            origin_domain,
            msg_ctxs,
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
    max_last_known_message_nonce_gauge: IntGauge,
    last_known_message_nonce_gauges: HashMap<u32, IntGauge>,
}

impl MessageDbLoaderMetrics {
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
                    "db_loader_loop",
                    origin.name(),
                    destination.name(),
                ]),
            );
        }
        Self {
            max_last_known_message_nonce_gauge: metrics
                .last_known_message_nonce()
                .with_label_values(&["db_loader_loop", origin.name(), "any"]),
            last_known_message_nonce_gauges: gauges,
        }
    }

    fn get(&self, destination: u32) -> Option<&IntGauge> {
        self.last_known_message_nonce_gauges.get(&destination)
    }
}

#[cfg(test)]
pub mod tests;
