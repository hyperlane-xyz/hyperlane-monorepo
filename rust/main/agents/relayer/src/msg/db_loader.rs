use std::{
    cmp::max,
    collections::{BTreeSet, HashMap, HashSet},
    fmt::{Debug, Formatter},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use derive_new::new;
use ethers::utils::hex;
use eyre::Result;
use futures_util::{stream::FuturesUnordered, StreamExt};
use hyperlane_base::{
    broadcast::IndexingNotification,
    db::{HyperlaneDb, HyperlaneRocksDB},
    CoreMetrics,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneMessage, QueueOperation, H256};
use parking_lot::Mutex;
use prometheus::{HistogramVec, IntCounterVec, IntGauge, IntGaugeVec};
use tokio::sync::mpsc::{error::TryRecvError, error::TrySendError, Receiver, Sender};
use tracing::{debug, instrument, trace};

use super::{
    blacklist::AddressBlacklist, metadata::AppContextClassifier, pending_message::*,
    QueueOperationBatch,
};
use crate::{db_loader::DbLoaderExt, settings::matching_list::MatchingList};

const LEGACY_MIGRATION_BATCH_SIZE: usize = 256;

/// Finds unprocessed messages from an origin and submits them through a channel
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
    send_channels: HashMap<u32, Sender<QueueOperationBatch>>,
    /// Needed context to send a message for each destination chain
    destination_ctxs: HashMap<u32, Arc<MessageContext>>,
    metric_app_contexts: Arc<Vec<(MatchingList, String)>>,
    db: HyperlaneRocksDB,
    // Reconcile every startup so a rollback binary cannot leave records unindexed.
    migration_iterator: Option<LegacyMessageIterator>,
    destination_iterators: Vec<DestinationIndexIterator>,
    next_destination: usize,
    destination_scan_pending: bool,
    max_retries: u32,
    index_notifications: Option<Receiver<IndexingNotification>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum IndexDirection {
    High,
    Low,
    Reconsider,
}

#[derive(Debug)]
struct DestinationIndexIterator {
    destination: u32,
    destination_label: Arc<str>,
    high_nonce: Option<u32>,
    low_nonce: Option<u32>,
    next_direction: IndexDirection,
    reconsider_nonces: BTreeSet<u32>,
    low_range_reopen_pending: bool,
    loaded_messages: Arc<Mutex<HashSet<H256>>>,
}

impl DestinationIndexIterator {
    fn new(destination: u32, highest_seen_nonce: Option<u32>) -> Self {
        Self {
            destination,
            destination_label: destination.to_string().into(),
            high_nonce: Some(highest_seen_nonce.unwrap_or_default()),
            low_nonce: highest_seen_nonce.and_then(|nonce| nonce.checked_sub(1)),
            next_direction: IndexDirection::High,
            reconsider_nonces: BTreeSet::new(),
            low_range_reopen_pending: false,
            loaded_messages: Default::default(),
        }
    }

    fn peek(
        &mut self,
        db: &HyperlaneRocksDB,
        metrics: &MessageDbLoaderMetrics,
    ) -> Result<Option<(IndexDirection, u32, H256)>> {
        if self.low_nonce.is_none() && self.low_range_reopen_pending {
            self.low_range_reopen_pending = false;
            self.reopen_low_range();
        }

        if let Some(nonce) = self.reconsider_nonces.first().copied() {
            metrics
                .logical_db_reads
                .with_label_values(&[
                    metrics.origin.as_str(),
                    self.destination_label.as_ref(),
                    "destination_index",
                    "index",
                ])
                .inc();
            if let Some((indexed_nonce, message_id)) =
                db.retrieve_pending_message_at_or_after(self.destination, nonce)?
            {
                if indexed_nonce == nonce {
                    return Ok(Some((IndexDirection::Reconsider, nonce, message_id)));
                }
            }
            self.reconsider_nonces.remove(&nonce);
        }

        let directions = match self.next_direction {
            IndexDirection::High | IndexDirection::Reconsider => {
                [IndexDirection::High, IndexDirection::Low]
            }
            IndexDirection::Low => [IndexDirection::Low, IndexDirection::High],
        };
        let mut reopened_low_range = false;
        for direction in directions {
            let nonce = match direction {
                IndexDirection::High => self.high_nonce,
                IndexDirection::Low => self.low_nonce,
                IndexDirection::Reconsider => None,
            };
            let Some(nonce) = nonce else {
                continue;
            };
            metrics
                .logical_db_reads
                .with_label_values(&[
                    metrics.origin.as_str(),
                    self.destination_label.as_ref(),
                    "destination_index",
                    "index",
                ])
                .inc();
            let entry = match direction {
                IndexDirection::High => {
                    db.retrieve_pending_message_at_or_after(self.destination, nonce)?
                }
                IndexDirection::Low => {
                    db.retrieve_pending_message_at_or_before(self.destination, nonce)?
                }
                IndexDirection::Reconsider => unreachable!(),
            };
            if let Some((nonce, message_id)) = entry {
                return Ok(Some((direction, nonce, message_id)));
            }
            if direction == IndexDirection::Low {
                self.low_nonce = None;
                if self.low_range_reopen_pending {
                    self.low_range_reopen_pending = false;
                    self.reopen_low_range();
                    reopened_low_range = true;
                }
            }
        }
        if reopened_low_range {
            return self.peek(db, metrics);
        }
        Ok(None)
    }

    fn advance(&mut self, direction: IndexDirection, nonce: u32) {
        match direction {
            IndexDirection::High => {
                self.high_nonce = nonce.checked_add(1);
                self.next_direction = IndexDirection::Low;
            }
            IndexDirection::Low => {
                self.low_nonce = nonce.checked_sub(1);
                self.next_direction = IndexDirection::High;
            }
            IndexDirection::Reconsider => {
                self.reconsider_nonces.remove(&nonce);
            }
        }
    }

    fn reconsider(&mut self, nonce: u32) {
        let covered_by_high = self.high_nonce.is_some_and(|high| nonce >= high);
        let covered_by_low = self.low_nonce.is_some_and(|low| nonce <= low);
        if !covered_by_high && !covered_by_low {
            self.reconsider_nonces.insert(nonce);
        }
    }

    fn request_low_range_reopen(&mut self) {
        if self.low_nonce.is_none() {
            self.reopen_low_range();
        } else {
            self.low_range_reopen_pending = true;
        }
    }

    fn reopen_low_range(&mut self) {
        self.low_nonce = match self.high_nonce {
            Some(nonce) => nonce.checked_sub(1),
            // `None` means the high scan advanced past the largest u32 nonce.
            None => Some(u32::MAX),
        };
    }
}

#[derive(Debug)]
struct LegacyMessageIterator {
    low_nonce_iter: DirectionalNonceIterator,
    high_nonce_iter: DirectionalNonceIterator,
    // here for debugging purposes
    _domain: String,
}

impl LegacyMessageIterator {
    #[instrument(skip(db), ret)]
    fn new(db: Arc<dyn HyperlaneDb>) -> Result<(Self, Option<u32>)> {
        let high_nonce = db.retrieve_highest_seen_message_nonce()?;
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
            "Initialized LegacyMessageIterator"
        );
        Ok((
            Self {
                low_nonce_iter,
                high_nonce_iter,
                _domain: domain,
            },
            high_nonce,
        ))
    }

    async fn try_get_next_message(
        &mut self,
        metrics: &MessageDbLoaderMetrics,
    ) -> Result<Option<HyperlaneMessage>> {
        let status = if self.high_nonce_iter.nonce.is_some() {
            let status = self.high_nonce_iter.try_get_next_nonce(metrics)?;
            // Newer messages are atomically indexed, so migration stops at its startup watermark.
            self.high_nonce_iter.nonce = None;
            status
        } else if self.low_nonce_iter.nonce.is_some() {
            let status = self.low_nonce_iter.try_get_next_nonce(metrics)?;
            // Legacy gaps are safe to cross because this iterator has a fixed startup watermark.
            self.low_nonce_iter.iterate();
            status
        } else {
            return Ok(None);
        };
        tokio::task::yield_now().await;
        Ok(match status {
            MessageStatus::Processable(message) => Some(message),
            MessageStatus::Unindexed | MessageStatus::Processed => None,
        })
    }

    fn migration_complete(&self) -> bool {
        self.high_nonce_iter.nonce.is_none() && self.low_nonce_iter.nonce.is_none()
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
            let destination = message.destination.to_string();
            metrics
                .logical_db_reads
                .with_label_values(&[
                    metrics.origin.as_str(),
                    destination.as_str(),
                    "migration",
                    "message",
                ])
                .inc();
            metrics
                .records_examined
                .with_label_values(&[metrics.origin.as_str(), destination.as_str(), "migration"])
                .inc();
            Self::update_max_nonce_gauge(&message, metrics);
            metrics
                .logical_db_reads
                .with_label_values(&[
                    metrics.origin.as_str(),
                    destination.as_str(),
                    "migration",
                    "processed",
                ])
                .inc();
            if !self.is_message_processed()? {
                trace!(hyp_message=?message, iterator=?self, "Found processable message");
                return Ok(MessageStatus::Processable(message));
            } else {
                return Ok(MessageStatus::Processed);
            }
        }
        metrics
            .logical_db_reads
            .with_label_values(&[metrics.origin.as_str(), "all", "migration", "message"])
            .inc();
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
            "MessageDbLoader {{ message_whitelist: {:?}, message_blacklist: {:?}, address_blacklist: {:?}, migration_iterator: {:?}, destination_iterators: {:?}}}",
            self.message_whitelist,
            self.message_blacklist,
            self.address_blacklist,
            self.migration_iterator,
            self.destination_iterators,
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
        self.db.domain()
    }

    /// One round of processing, extracted from infinite work loop for
    /// testing purposes.
    async fn tick(&mut self) -> Result<()> {
        self.drain_index_notifications()?;
        let migration_was_active = self.migration_iterator.is_some();
        self.migrate_legacy_batch().await?;

        if self.destination_scan_pending {
            self.metrics
                .update_ingress_depths(&self.send_channels, &self.destination_iterators);

            let destination_count = self.destination_iterators.len();
            for _ in 0..destination_count {
                let index = self.next_destination;
                self.next_destination = (self.next_destination + 1) % destination_count;
                if self.try_load_destination(index).await? {
                    return Ok(());
                }
            }
            self.destination_scan_pending = false;
        }

        let migration_blocked = self
            .destination_iterators
            .iter()
            .any(|iterator| !iterator.reconsider_nonces.is_empty());
        if migration_was_active && self.migration_iterator.is_none() {
            return Ok(());
        }
        if self.migration_iterator.is_none() || migration_blocked {
            self.wait_for_work().await;
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
        send_channels: HashMap<u32, Sender<QueueOperationBatch>>,
        destination_ctxs: HashMap<u32, Arc<MessageContext>>,
        metric_app_contexts: Arc<Vec<(MatchingList, String)>>,
        max_retries: u32,
        index_notifications: Option<Receiver<IndexingNotification>>,
    ) -> Result<Self> {
        let (migration_iterator, highest_seen_nonce) =
            LegacyMessageIterator::new(Arc::new(db.clone()) as Arc<dyn HyperlaneDb>)?;
        let mut destinations: Vec<_> = send_channels.keys().copied().collect();
        destinations.sort_unstable();
        let destination_iterators = destinations
            .into_iter()
            .map(|destination| DestinationIndexIterator::new(destination, highest_seen_nonce))
            .collect();
        Ok(Self {
            message_whitelist,
            message_blacklist,
            address_blacklist,
            metrics,
            send_channels,
            destination_ctxs,
            metric_app_contexts,
            migration_iterator: Some(migration_iterator),
            db,
            destination_iterators,
            next_destination: 0,
            destination_scan_pending: true,
            max_retries,
            index_notifications,
        })
    }

    /// Discard already-observed index notifications so this receiver cannot
    /// backpressure the message indexer while the loader is processing a backlog.
    fn drain_index_notifications(&mut self) -> Result<()> {
        let mut disconnected = false;
        let mut notifications = Vec::new();
        if let Some(receiver) = self.index_notifications.as_mut() {
            loop {
                match receiver.try_recv() {
                    Ok(notification) => notifications.push(notification),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }
        if disconnected {
            self.index_notifications = None;
        }
        for notification in notifications {
            if let Err(err) = self.apply_index_notification(notification) {
                self.request_low_range_reopens();
                return Err(err);
            }
        }
        Ok(())
    }

    fn apply_index_notification(&mut self, notification: IndexingNotification) -> Result<()> {
        self.destination_scan_pending = true;
        let mut fallback_reopen =
            notification.sequences.is_empty() || notification.sequences.iter().any(Option::is_none);
        for nonce in notification.sequences.into_iter().flatten() {
            self.metrics
                .logical_db_reads
                .with_label_values(&[
                    self.metrics.origin.as_str(),
                    "all",
                    "notification",
                    "message",
                ])
                .inc();
            let Some(message) = self.db.retrieve_message_by_nonce(nonce)? else {
                fallback_reopen = true;
                continue;
            };
            if let Some(iterator) = self
                .destination_iterators
                .iter_mut()
                .find(|iterator| iterator.destination == message.destination)
            {
                iterator.reconsider(nonce);
            }
        }
        if fallback_reopen {
            self.request_low_range_reopens();
        }
        Ok(())
    }

    fn request_low_range_reopens(&mut self) {
        self.destination_scan_pending = true;
        for iterator in &mut self.destination_iterators {
            iterator.request_low_range_reopen();
        }
    }

    /// Wake for new index work or destination capacity, retaining a polling fallback.
    async fn wait_for_work(&mut self) {
        const FALLBACK_POLL_INTERVAL: Duration = Duration::from_secs(1);

        let mut capacity_waiters: FuturesUnordered<_> = self
            .send_channels
            .values()
            .filter(|sender| sender.capacity() == 0 && !sender.is_closed())
            .cloned()
            .map(Sender::reserve_owned)
            .collect();
        let capacity_wait = async {
            if capacity_waiters.is_empty() {
                std::future::pending::<()>().await
            } else {
                let _ = capacity_waiters.next().await;
            }
        };

        let (disconnected, notification) = if let Some(receiver) = self.index_notifications.as_mut()
        {
            tokio::select! {
                notification = receiver.recv() => match notification {
                    Some(notification) => (false, Some(notification)),
                    None => (true, None),
                },
                _ = capacity_wait => (false, None),
                _ = tokio::time::sleep(FALLBACK_POLL_INTERVAL) => (false, None),
            }
        } else {
            tokio::select! {
                _ = capacity_wait => (false, None),
                _ = tokio::time::sleep(FALLBACK_POLL_INTERVAL) => (false, None),
            }
        };

        if disconnected {
            self.index_notifications = None;
        }
        if let Some(notification) = notification {
            if let Err(err) = self.apply_index_notification(notification) {
                debug!(?err, "Failed to apply index notification");
                self.request_low_range_reopens();
            }
        }
        self.destination_scan_pending = true;
    }

    async fn migrate_legacy_batch(&mut self) -> Result<()> {
        if self
            .destination_iterators
            .iter()
            .any(|iterator| !iterator.reconsider_nonces.is_empty())
        {
            return Ok(());
        }
        let Some(iterator) = self.migration_iterator.as_mut() else {
            return Ok(());
        };
        let _timer = self
            .metrics
            .scan_duration_seconds
            .with_label_values(&[self.metrics.origin.as_str(), "all", "migration"])
            .start_timer();
        for _ in 0..LEGACY_MIGRATION_BATCH_SIZE {
            if let Some(message) = iterator.try_get_next_message(&self.metrics).await? {
                let destination = message.destination.to_string();
                self.metrics
                    .logical_db_reads
                    .with_label_values(&[
                        self.metrics.origin.as_str(),
                        destination.as_str(),
                        "migration",
                        "reconcile",
                    ])
                    .inc_by(2);
                self.db.reconcile_pending_message_index(&message)?;
                if let Some(iterator) = self
                    .destination_iterators
                    .iter_mut()
                    .find(|iterator| iterator.destination == message.destination)
                {
                    iterator.reconsider(message.nonce);
                }
                self.destination_scan_pending = true;
                break;
            }
            if iterator.migration_complete() {
                break;
            }
        }
        if iterator.migration_complete() {
            self.migration_iterator = None;
        }
        Ok(())
    }

    async fn try_load_destination(&mut self, iterator_index: usize) -> Result<bool> {
        let destination = self.destination_iterators[iterator_index].destination;
        let destination_label = self.destination_iterators[iterator_index]
            .destination_label
            .clone();
        let _timer = self
            .metrics
            .scan_duration_seconds
            .with_label_values(&[
                self.metrics.origin.as_str(),
                destination_label.as_ref(),
                "destination_index",
            ])
            .start_timer();
        let Some(sender) = self.send_channels.get(&destination).cloned() else {
            return Ok(false);
        };
        if !sender.is_closed() && sender.capacity() == 0 {
            return Ok(false);
        }
        let Some((direction, nonce, indexed_message_id)) =
            self.destination_iterators[iterator_index].peek(&self.db, &self.metrics)?
        else {
            return Ok(false);
        };
        self.metrics
            .records_examined
            .with_label_values(&[
                self.metrics.origin.as_str(),
                destination_label.as_ref(),
                "destination_index",
            ])
            .inc();
        self.metrics
            .logical_db_reads
            .with_label_values(&[
                self.metrics.origin.as_str(),
                destination_label.as_ref(),
                "destination_index",
                "message",
            ])
            .inc();
        let message = self.db.retrieve_message_by_nonce(nonce)?;
        let Some(message) = message else {
            self.db
                .delete_pending_message_index_by_nonce(destination, nonce)?;
            self.destination_iterators[iterator_index].advance(direction, nonce);
            return Ok(true);
        };
        if message.id() != indexed_message_id || message.destination != destination {
            self.db
                .delete_pending_message_index_by_nonce(destination, nonce)?;
            self.metrics
                .logical_db_reads
                .with_label_values(&[
                    self.metrics.origin.as_str(),
                    destination_label.as_ref(),
                    "destination_index",
                    "reconcile",
                ])
                .inc_by(2);
            self.db.reconcile_pending_message_index(&message)?;
            if message.destination == destination {
                return Ok(true);
            }
            self.destination_iterators[iterator_index].advance(direction, nonce);
            if let Some(target) = self
                .destination_iterators
                .iter_mut()
                .find(|iterator| iterator.destination == message.destination)
            {
                target.reconsider(nonce);
            }
            return Ok(true);
        }
        self.metrics
            .logical_db_reads
            .with_label_values(&[
                self.metrics.origin.as_str(),
                destination_label.as_ref(),
                "destination_index",
                "processed",
            ])
            .inc();
        if self
            .db
            .retrieve_processed_by_nonce(&nonce)?
            .unwrap_or(false)
        {
            self.db.delete_pending_message_index(&message)?;
            self.destination_iterators[iterator_index].advance(direction, nonce);
            return Ok(true);
        }

        self.metrics
            .logical_db_reads
            .with_label_values(&[
                self.metrics.origin.as_str(),
                destination_label.as_ref(),
                "destination_index",
                "terminal",
            ])
            .inc();
        if self.db.retrieve_terminally_dropped_message(&message.id())? {
            self.db.delete_pending_message_index(&message)?;
            self.destination_iterators[iterator_index].advance(direction, nonce);
            return Ok(true);
        }

        let Some(loaded_message_guard) = LoadedMessageGuard::try_acquire(
            message.id(),
            self.destination_iterators[iterator_index]
                .loaded_messages
                .clone(),
            self.db.clone(),
        ) else {
            self.destination_iterators[iterator_index].advance(direction, nonce);
            return Ok(true);
        };

        DirectionalNonceIterator::update_max_nonce_gauge(&message, &self.metrics);
        // Retain disqualified entries so restart or configuration changes reconsider them.
        if !self.message_whitelist.msg_matches(&message, true) {
            debug!(?message, "Message not whitelisted, skipping");
            self.destination_iterators[iterator_index].advance(direction, nonce);
            return Ok(true);
        }
        if self.message_blacklist.msg_matches(&message, false) {
            debug!(?message, "Message blacklisted, skipping");
            self.destination_iterators[iterator_index].advance(direction, nonce);
            return Ok(true);
        }
        if let Some(blacklisted_address) = self.address_blacklist.find_blacklisted_address(&message)
        {
            debug!(
                ?message,
                blacklisted_address = hex::encode(blacklisted_address),
                "Message involves blacklisted address, skipping"
            );
            self.destination_iterators[iterator_index].advance(direction, nonce);
            return Ok(true);
        }
        let Some(destination_msg_ctx) = self.destination_ctxs.get(&destination) else {
            debug!(
                ?message,
                "Message destined for unknown message context, skipping"
            );
            self.destination_iterators[iterator_index].advance(direction, nonce);
            return Ok(true);
        };

        let app_context = AppContextClassifier::new(self.metric_app_contexts.clone())
            .get_app_context(&message)
            .await?;
        let Some(mut pending_message) = PendingMessage::maybe_from_persisted_retries(
            message,
            destination_msg_ctx.clone(),
            app_context,
            self.max_retries,
        ) else {
            self.destination_iterators[iterator_index].advance(direction, nonce);
            return Ok(true);
        };
        pending_message.set_loaded_message_guard(loaded_message_guard);
        match sender.try_send(vec![Box::new(pending_message) as QueueOperation]) {
            Ok(()) => {
                self.destination_iterators[iterator_index].advance(direction, nonce);
                Ok(true)
            }
            Err(TrySendError::Full(_)) => Ok(false),
            Err(TrySendError::Closed(_)) => {
                eyre::bail!("Message processor channel closed for destination {destination}")
            }
        }
    }
}

/// Metric vectors shared by all origin-specific message DB loaders.
#[derive(Debug, Clone)]
pub struct MessageDbLoaderMetricsShared {
    records_examined: IntCounterVec,
    logical_db_reads: IntCounterVec,
    scan_duration_seconds: HistogramVec,
    ingress_depth: IntGaugeVec,
}

impl MessageDbLoaderMetricsShared {
    /// Register message DB loader metrics once per relayer.
    pub fn new(metrics: &CoreMetrics) -> Result<Self> {
        Ok(Self {
            records_examined: metrics.new_int_counter(
                "message_db_loader_records_examined_total",
                "Pending-message records examined by the message DB loader",
                &["origin", "destination", "phase"],
            )?,
            logical_db_reads: metrics.new_int_counter(
                "message_db_loader_logical_db_reads_total",
                "Logical database reads performed by the message DB loader",
                &["origin", "destination", "phase", "operation"],
            )?,
            scan_duration_seconds: metrics.new_histogram(
                "message_db_loader_scan_duration_seconds",
                "Time spent in one message DB loader scan step",
                &["origin", "destination", "phase"],
                vec![0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0],
            )?,
            ingress_depth: metrics.new_int_gauge(
                "message_db_loader_ingress_depth",
                "Operations queued by the DB loader for a destination processor",
                &["destination"],
            )?,
        })
    }

    /// Bind the shared metric vectors to an origin-specific loader.
    pub fn for_origin(
        &self,
        metrics: &CoreMetrics,
        origin: &HyperlaneDomain,
    ) -> MessageDbLoaderMetrics {
        MessageDbLoaderMetrics {
            last_known_message_nonce_gauge: metrics
                .last_known_message_nonce()
                .with_label_values(&["db_loader_loop", origin.name()]),
            origin: origin.name().to_owned(),
            records_examined: self.records_examined.clone(),
            logical_db_reads: self.logical_db_reads.clone(),
            scan_duration_seconds: self.scan_duration_seconds.clone(),
            ingress_depth: self.ingress_depth.clone(),
        }
    }
}

#[derive(Debug)]
pub struct MessageDbLoaderMetrics {
    last_known_message_nonce_gauge: IntGauge,
    origin: String,
    records_examined: IntCounterVec,
    logical_db_reads: IntCounterVec,
    scan_duration_seconds: HistogramVec,
    ingress_depth: IntGaugeVec,
}

impl MessageDbLoaderMetrics {
    fn update_ingress_depths(
        &self,
        send_channels: &HashMap<u32, Sender<QueueOperationBatch>>,
        destination_iterators: &[DestinationIndexIterator],
    ) {
        for iterator in destination_iterators {
            let Some(sender) = send_channels.get(&iterator.destination) else {
                continue;
            };
            let depth = sender.max_capacity().saturating_sub(sender.capacity());
            self.ingress_depth
                .with_label_values(&[iterator.destination_label.as_ref()])
                .set(depth as i64);
        }
    }
}

#[cfg(test)]
pub mod tests;
