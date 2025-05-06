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
use crate::{processor::ProcessorExt, settings::matching_list::MatchingList};

/// Finds unprocessed messages from an origin and submits then through a channel
/// for to the appropriate destination.
#[allow(clippy::too_many_arguments)]
pub struct MessageProcessor {
    /// A matching list of messages that should be whitelisted.
    message_whitelist: Arc<MatchingList>,
    /// A matching list of messages that should be blacklisted.
    message_blacklist: Arc<MatchingList>,
    /// Addresses that messages may not interact with.
    address_blacklist: Arc<AddressBlacklist>,
    metrics: MessageProcessorMetrics,
    /// channel for each destination chain to send operations (i.e. message
    /// submissions) to
    send_channels: HashMap<u32, UnboundedSender<QueueOperation>>,
    /// Needed context to send a message for each destination chain
    destination_ctxs: HashMap<u32, Arc<MessageContext>>,
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
        metrics: &MessageProcessorMetrics,
    ) -> Result<Option<HyperlaneMessage>> {
        loop {
            let high_nonce_message_status = self.high_nonce_iter.try_get_next_nonce(metrics)?;
            let low_nonce_message_status = self.low_nonce_iter.try_get_next_nonce(metrics)?;

            match (high_nonce_message_status, low_nonce_message_status) {
                // Always prioritize advancing the the high nonce iterator, as
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
        metrics: &MessageProcessorMetrics,
    ) -> Result<MessageStatus<HyperlaneMessage>> {
        if let Some(message) = self.indexed_message_with_nonce()? {
            Self::update_max_nonce_gauge(&message, metrics);
            if !self.is_message_processed()? {
                debug!(hyp_message=?message, iterator=?self, "Found processable message");
                return Ok(MessageStatus::Processable(message));
            } else {
                return Ok(MessageStatus::Processed);
            }
        }
        Ok(MessageStatus::Unindexed)
    }

    fn update_max_nonce_gauge(message: &HyperlaneMessage, metrics: &MessageProcessorMetrics) {
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

impl Debug for MessageProcessor {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MessageProcessor {{ message_whitelist: {:?}, message_blacklist: {:?}, address_blacklist: {:?}, nonce_iterator: {:?}}}",
            self.message_whitelist, self.message_blacklist, self.address_blacklist, self.nonce_iterator
        )
    }
}

#[async_trait]
impl ProcessorExt for MessageProcessor {
    /// The name of this processor
    fn name(&self) -> String {
        format!("processor::message::{}", self.domain().name())
    }

    /// The domain this processor is getting messages from.
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
            debug!(
                ?msg,
                cursor = ?self.nonce_iterator,
                "Processor working on message"
            );
            let destination = msg.destination;

            // Skip if not whitelisted.
            if !self.message_whitelist.msg_matches(&msg, true) {
                debug!(?msg, whitelist=?self.message_whitelist, "Message not whitelisted, skipping");
                return Ok(());
            }

            // Skip if the message is blacklisted
            if self.message_blacklist.msg_matches(&msg, false) {
                debug!(?msg, blacklist=?self.message_blacklist, "Message blacklisted, skipping");
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

impl MessageProcessor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        db: HyperlaneRocksDB,
        message_whitelist: Arc<MatchingList>,
        message_blacklist: Arc<MatchingList>,
        address_blacklist: Arc<AddressBlacklist>,
        metrics: MessageProcessorMetrics,
        send_channels: HashMap<u32, UnboundedSender<QueueOperation>>,
        destination_ctxs: HashMap<u32, Arc<MessageContext>>,
        metric_app_contexts: Vec<(MatchingList, String)>,
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
        trace!(nonce_iterator=?self.nonce_iterator, "Trying to get the next processor message");
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
pub struct MessageProcessorMetrics {
    pub max_last_known_message_nonce_gauge: IntGauge,
    pub last_known_message_nonce_gauges: HashMap<u32, IntGauge>,
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

#[cfg(test)]
pub mod test {
    use std::{collections::VecDeque, path::PathBuf, str::FromStr, time::Instant};

    use futures::future::try_join_all;
    use hyperlane_ethereum::{ConnectionConf, RpcConnectionConf};
    use prometheus::{
        opts, register_int_gauge_vec, CounterVec, IntCounter, IntCounterVec, IntGaugeVec, Opts,
        Registry,
    };
    use serde::Serialize;
    use tokio::sync::Mutex;
    use tokio::{
        sync::{
            mpsc::{self, UnboundedReceiver},
            RwLock,
        },
        time::sleep,
    };
    use tokio_metrics::TaskMonitor;

    use hyperlane_base::{
        cache::{LocalCache, MeteredCache, MeteredCacheConfig, MeteredCacheMetrics, OptionalCache},
        db::{
            test_utils, DbResult, HyperlaneRocksDB, InterchainGasExpenditureData,
            InterchainGasPaymentData, DB,
        },
        settings::{ChainConf, ChainConnectionConf, CoreContractAddresses, Settings},
    };
    use hyperlane_core::{
        config::OpSubmissionConfig, identifiers::UniqueIdentifier, test_utils::dummy_domain,
        BatchItem, ChainResult, Decode, GasPaymentKey, InterchainGasPayment,
        InterchainGasPaymentMeta, KnownHyperlaneDomain, Mailbox, MerkleTreeInsertion,
        MessageSubmissionData, PendingOperation, PendingOperationResult, PendingOperationStatus,
        ReorgPeriod, ReprepareReason, SubmitterType, TryBatchAs, TxOutcome, H160, H256, U256,
    };
    use hyperlane_operation_verifier::{
        ApplicationOperationVerifier, ApplicationOperationVerifierReport,
    };
    use hyperlane_test::mocks::{MockMailboxContract, MockValidatorAnnounceContract};
    use tracing::info_span;

    use crate::{
        merkle_tree::builder::MerkleTreeBuilder,
        metrics::message_submission::MessageSubmissionMetrics,
        msg::{
            gas_payment::GasPaymentEnforcer,
            metadata::{
                BaseMetadataBuilder, DefaultIsmCache, IsmAwareAppContextClassifier,
                IsmCachePolicyClassifier,
            },
            op_queue::OpQueue,
            op_submitter::{
                confirm_classic_task, prepare_classic_task, receive_task, submit_classic_task,
                SerialSubmitterMetrics,
            },
        },
        processor::Processor,
    };

    use super::*;

    pub struct DummyApplicationOperationVerifier {}

    #[async_trait]
    impl ApplicationOperationVerifier for DummyApplicationOperationVerifier {
        async fn verify(
            &self,
            _app_context: &Option<String>,
            _message: &HyperlaneMessage,
        ) -> Option<ApplicationOperationVerifierReport> {
            None
        }
    }

    pub fn dummy_processor_metrics(domain_id: u32) -> MessageProcessorMetrics {
        MessageProcessorMetrics {
            max_last_known_message_nonce_gauge: IntGauge::new(
                "dummy_max_last_known_message_nonce_gauge",
                "help string",
            )
            .unwrap(),
            last_known_message_nonce_gauges: HashMap::from([(
                domain_id,
                IntGauge::new("dummy_last_known_message_nonce_gauge", "help string").unwrap(),
            )]),
        }
    }

    pub fn dummy_cache_metrics() -> MeteredCacheMetrics {
        MeteredCacheMetrics {
            hit_count: IntCounterVec::new(
                prometheus::Opts::new("dummy_hit_count", "help string"),
                &["cache_name", "method", "status"],
            )
            .ok(),
            miss_count: IntCounterVec::new(
                prometheus::Opts::new("dummy_miss_count", "help string"),
                &["cache_name", "method", "status"],
            )
            .ok(),
        }
    }

    pub fn dummy_submission_metrics() -> MessageSubmissionMetrics {
        MessageSubmissionMetrics {
            origin: "".to_string(),
            destination: "".to_string(),
            last_known_nonce: IntGauge::new("last_known_nonce_gauge", "help string").unwrap(),
            messages_processed: IntCounter::new("message_processed_gauge", "help string").unwrap(),
            metadata_build_count: IntCounterVec::new(
                Opts::new("metadata_build_count", "help string"),
                &["app_context", "origin", "remote", "status"],
            )
            .unwrap(),
            metadata_build_duration: CounterVec::new(
                Opts::new("metadata_build_duration", "help string"),
                &["app_context", "origin", "remote", "status"],
            )
            .unwrap(),
        }
    }

    fn dummy_chain_conf(domain: &HyperlaneDomain) -> ChainConf {
        ChainConf {
            domain: domain.clone(),
            signer: Default::default(),
            submitter: Default::default(),
            estimated_block_time: Duration::from_secs_f64(1.1),
            reorg_period: Default::default(),
            addresses: Default::default(),
            connection: ChainConnectionConf::Ethereum(hyperlane_ethereum::ConnectionConf {
                rpc_connection: hyperlane_ethereum::RpcConnectionConf::Http {
                    url: "http://example.com".parse().unwrap(),
                },
                transaction_overrides: Default::default(),
                op_submission_config: Default::default(),
            }),
            metrics_conf: Default::default(),
            index: Default::default(),
        }
    }

    fn dummy_metadata_builder(
        origin_domain: &HyperlaneDomain,
        destination_domain: &HyperlaneDomain,
        db: &HyperlaneRocksDB,
        cache: OptionalCache<MeteredCache<LocalCache>>,
    ) -> BaseMetadataBuilder {
        let mut settings = Settings::default();
        settings.chains.insert(
            origin_domain.name().to_owned(),
            dummy_chain_conf(origin_domain),
        );
        settings.chains.insert(
            destination_domain.name().to_owned(),
            dummy_chain_conf(destination_domain),
        );
        let destination_chain_conf = settings.chain_setup(destination_domain).unwrap();
        let core_metrics = CoreMetrics::new("dummy_relayer", 37582, Registry::new()).unwrap();
        let default_ism_getter = DefaultIsmCache::new(Arc::new(
            MockMailboxContract::new_with_default_ism(H256::zero()),
        ));
        BaseMetadataBuilder::new(
            origin_domain.clone(),
            destination_chain_conf.clone(),
            Arc::new(RwLock::new(MerkleTreeBuilder::new())),
            Arc::new(MockValidatorAnnounceContract::default()),
            false,
            Arc::new(core_metrics),
            cache,
            db.clone(),
            IsmAwareAppContextClassifier::new(default_ism_getter.clone(), vec![]),
            IsmCachePolicyClassifier::new(default_ism_getter, Default::default()),
        )
    }

    fn dummy_message_processor(
        origin_domain: &HyperlaneDomain,
        destination_domain: &HyperlaneDomain,
        db: &HyperlaneRocksDB,
        cache: OptionalCache<MeteredCache<LocalCache>>,
    ) -> (MessageProcessor, UnboundedReceiver<QueueOperation>) {
        let base_metadata_builder =
            dummy_metadata_builder(origin_domain, destination_domain, db, cache.clone());
        let message_context = Arc::new(MessageContext {
            destination_mailbox: Arc::new(MockMailboxContract::new_with_default_ism(H256::zero())),
            origin_db: Arc::new(db.clone()),
            cache,
            metadata_builder: Arc::new(base_metadata_builder),
            origin_gas_payment_enforcer: Arc::new(GasPaymentEnforcer::new([], db.clone())),
            transaction_gas_limit: Default::default(),
            metrics: dummy_submission_metrics(),
            application_operation_verifier: Some(Arc::new(DummyApplicationOperationVerifier {})),
        });

        let (send_channel, receive_channel) = mpsc::unbounded_channel::<QueueOperation>();
        (
            MessageProcessor::new(
                db.clone(),
                Default::default(),
                Default::default(),
                Default::default(),
                dummy_processor_metrics(origin_domain.id()),
                HashMap::from([(destination_domain.id(), send_channel)]),
                HashMap::from([(destination_domain.id(), message_context)]),
                vec![],
                DEFAULT_MAX_MESSAGE_RETRIES,
            ),
            receive_channel,
        )
    }

    fn dummy_hyperlane_message(destination: &HyperlaneDomain, nonce: u32) -> HyperlaneMessage {
        HyperlaneMessage {
            version: Default::default(),
            nonce,
            // Origin must be different from the destination
            origin: destination.id() + 1,
            sender: Default::default(),
            destination: destination.id(),
            recipient: Default::default(),
            body: Default::default(),
        }
    }

    fn add_db_entry(db: &HyperlaneRocksDB, msg: &HyperlaneMessage, retry_count: u32) {
        db.store_message(msg, Default::default()).unwrap();
        if retry_count > 0 {
            db.store_pending_message_retry_count_by_message_id(&msg.id(), &retry_count)
                .unwrap();
        }
    }

    /// Only adds database entries to the pending message prefix if the message's
    /// retry count is greater than zero
    fn persist_retried_messages(
        retries: &[u32],
        db: &HyperlaneRocksDB,
        destination_domain: &HyperlaneDomain,
    ) {
        let mut nonce = 0;
        retries.iter().for_each(|num_retries| {
            let message = dummy_hyperlane_message(destination_domain, nonce);
            add_db_entry(db, &message, *num_retries);
            nonce += 1;
        });
    }

    /// Runs the processor and returns the first `num_operations` to arrive on the
    /// receiving end of the channel.
    /// A default timeout is used for all `n` operations to arrive, otherwise the function panics.
    async fn get_first_n_operations_from_processor(
        origin_domain: &HyperlaneDomain,
        destination_domain: &HyperlaneDomain,
        db: &HyperlaneRocksDB,
        cache: OptionalCache<MeteredCache<LocalCache>>,
        num_operations: usize,
    ) -> Vec<QueueOperation> {
        let (message_processor, mut receive_channel) =
            dummy_message_processor(origin_domain, destination_domain, db, cache);

        let processor = Processor::new(Box::new(message_processor), TaskMonitor::new());
        let process_fut = processor.spawn(info_span!("MessageProcessor"));
        let mut pending_messages = vec![];
        let pending_message_accumulator = async {
            while let Some(pm) = receive_channel.recv().await {
                pending_messages.push(pm);
                if pending_messages.len() == num_operations {
                    break;
                }
            }
        };
        tokio::select! {
            _ = process_fut => {},
            _ = pending_message_accumulator => {},
            _ = sleep(Duration::from_millis(200)) => { panic!("No PendingMessage received from the processor") }
        };
        pending_messages
    }

    mockall::mock! {
        pub Db {}

        impl Debug for Db {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        impl HyperlaneDb for Db {
            /// Retrieve the nonce of the highest processed message we're aware of
            fn retrieve_highest_seen_message_nonce(&self) -> DbResult<Option<u32>>;

            /// Retrieve a message by its nonce
            fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>>;

            /// Retrieve whether a message has been processed
            fn retrieve_processed_by_nonce(&self, nonce: &u32) -> DbResult<Option<bool>>;

            /// Get the origin domain of the database
            fn domain(&self) -> &HyperlaneDomain;

            fn store_message_id_by_nonce(&self, nonce: &u32, id: &H256) -> DbResult<()>;

            fn retrieve_message_id_by_nonce(&self, nonce: &u32) -> DbResult<Option<H256>>;

            fn store_message_by_id(&self, id: &H256, message: &HyperlaneMessage) -> DbResult<()>;

            fn retrieve_message_by_id(&self, id: &H256) -> DbResult<Option<HyperlaneMessage>>;

            fn store_dispatched_block_number_by_nonce(
                &self,
                nonce: &u32,
                block_number: &u64,
            ) -> DbResult<()>;

            fn retrieve_dispatched_block_number_by_nonce(&self, nonce: &u32) -> DbResult<Option<u64>>;

            /// Store whether a message was processed by its nonce
            fn store_processed_by_nonce(&self, nonce: &u32, processed: &bool) -> DbResult<()>;

            fn store_processed_by_gas_payment_meta(
                &self,
                meta: &InterchainGasPaymentMeta,
                processed: &bool,
            ) -> DbResult<()>;

            fn retrieve_processed_by_gas_payment_meta(
                &self,
                meta: &InterchainGasPaymentMeta,
            ) -> DbResult<Option<bool>>;

            fn store_interchain_gas_expenditure_data_by_message_id(
                &self,
                message_id: &H256,
                data: &InterchainGasExpenditureData,
            ) -> DbResult<()>;

            fn retrieve_interchain_gas_expenditure_data_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<InterchainGasExpenditureData>>;

            /// Store the status of an operation by its message id
            fn store_status_by_message_id(
                &self,
                message_id: &H256,
                status: &PendingOperationStatus,
            ) -> DbResult<()>;

            /// Retrieve the status of an operation by its message id
            fn retrieve_status_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<PendingOperationStatus>>;

            fn store_interchain_gas_payment_data_by_gas_payment_key(
                &self,
                key: &GasPaymentKey,
                data: &InterchainGasPaymentData,
            ) -> DbResult<()>;

            fn retrieve_interchain_gas_payment_data_by_gas_payment_key(
                &self,
                key: &GasPaymentKey,
            ) -> DbResult<Option<InterchainGasPaymentData>>;

            fn store_gas_payment_by_sequence(
                &self,
                sequence: &u32,
                payment: &InterchainGasPayment,
            ) -> DbResult<()>;

            fn retrieve_gas_payment_by_sequence(
                &self,
                sequence: &u32,
            ) -> DbResult<Option<InterchainGasPayment>>;

            fn store_gas_payment_block_by_sequence(
                &self,
                sequence: &u32,
                block_number: &u64,
            ) -> DbResult<()>;

            fn retrieve_gas_payment_block_by_sequence(&self, sequence: &u32) -> DbResult<Option<u64>>;

            /// Store the retry count for a pending message by its message id
            fn store_pending_message_retry_count_by_message_id(
                &self,
                message_id: &H256,
                count: &u32,
            ) -> DbResult<()>;

            /// Retrieve the retry count for a pending message by its message id
            fn retrieve_pending_message_retry_count_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<u32>>;

            fn store_merkle_tree_insertion_by_leaf_index(
                &self,
                leaf_index: &u32,
                insertion: &MerkleTreeInsertion,
            ) -> DbResult<()>;

            /// Retrieve the merkle tree insertion event by its leaf index
            fn retrieve_merkle_tree_insertion_by_leaf_index(
                &self,
                leaf_index: &u32,
            ) -> DbResult<Option<MerkleTreeInsertion>>;

            fn store_merkle_leaf_index_by_message_id(
                &self,
                message_id: &H256,
                leaf_index: &u32,
            ) -> DbResult<()>;

            /// Retrieve the merkle leaf index of a message in the merkle tree
            fn retrieve_merkle_leaf_index_by_message_id(&self, message_id: &H256) -> DbResult<Option<u32>>;

            fn store_merkle_tree_insertion_block_number_by_leaf_index(
                &self,
                leaf_index: &u32,
                block_number: &u64,
            ) -> DbResult<()>;

            fn retrieve_merkle_tree_insertion_block_number_by_leaf_index(
                &self,
                leaf_index: &u32,
            ) -> DbResult<Option<u64>>;

            fn store_highest_seen_message_nonce_number(&self, nonce: &u32) -> DbResult<()>;

            /// Retrieve the nonce of the highest processed message we're aware of
            fn retrieve_highest_seen_message_nonce_number(&self) -> DbResult<Option<u32>>;

            fn store_payload_ids_by_message_id(&self, message_id: &H256, payload_ids: Vec<UniqueIdentifier>) -> DbResult<()>;

            fn retrieve_payload_ids_by_message_id(&self, message_id: &H256) -> DbResult<Option<Vec<UniqueIdentifier>>>;
        }
    }

    #[tokio::test]
    async fn test_full_pending_message_persistence_flow() {
        test_utils::run_test_db(|db| async move {
            let origin_domain = dummy_domain(0, "dummy_origin_domain");
            let destination_domain = dummy_domain(1, "dummy_destination_domain");
            let db = HyperlaneRocksDB::new(&origin_domain, db);
            let cache = OptionalCache::new(Some(MeteredCache::new(
                LocalCache::new("test-cache"),
                dummy_cache_metrics(),
                MeteredCacheConfig {
                    cache_name: "test-cache".to_owned(),
                },
            )));

            // Assume the message syncer stored some new messages in HyperlaneDB
            let msg_retries = vec![0, 0, 0];
            persist_retried_messages(&msg_retries, &db, &destination_domain);

            // Run parser to load the messages in memory
            let pending_messages = get_first_n_operations_from_processor(
                &origin_domain,
                &destination_domain,
                &db,
                cache.clone(),
                msg_retries.len(),
            )
            .await;

            // Set some retry counts. This should update HyperlaneDB entries too.
            let msg_retries_to_set = [3, 0, 10];
            pending_messages
                .into_iter()
                .enumerate()
                .for_each(|(i, mut pm)| pm.set_retries(msg_retries_to_set[i]));

            // Run parser again
            let pending_messages = get_first_n_operations_from_processor(
                &origin_domain,
                &destination_domain,
                &db,
                cache.clone(),
                msg_retries.len(),
            )
            .await;

            // Expect the HyperlaneDB entry to have been updated, so the `OpQueue` in the submitter
            // can be accurately reconstructed on restart.
            // If the retry counts were correctly persisted, the backoffs will have the expected value.
            pending_messages
                .iter()
                .zip(msg_retries_to_set.iter())
                .for_each(|(pm, expected_retries)| {
                    // Round up the actual backoff because it was calculated with an `Instant::now()` that was a fraction of a second ago
                    let expected_backoff = PendingMessage::calculate_msg_backoff(
                        *expected_retries,
                        DEFAULT_MAX_MESSAGE_RETRIES,
                        None,
                    )
                    .map(|b| b.as_secs_f32().round());
                    let actual_backoff = pm.next_attempt_after().map(|instant| {
                        instant.duration_since(Instant::now()).as_secs_f32().round()
                    });
                    assert_eq!(expected_backoff, actual_backoff);
                });
        })
        .await;
    }

    #[tokio::test]
    async fn test_forward_backward_iterator() {
        let mut mock_db = MockDb::new();
        const MAX_ONCHAIN_NONCE: u32 = 4;
        const MOCK_HIGHEST_SEEN_NONCE: u32 = 2;

        // How many times the db was queried for the max onchain nonce message
        let mut retrieve_calls_for_max_onchain_nonce = 0;

        mock_db
            .expect_domain()
            .return_const(dummy_domain(0, "dummy_domain"));
        mock_db
            .expect_retrieve_highest_seen_message_nonce()
            .returning(|| Ok(Some(MOCK_HIGHEST_SEEN_NONCE)));
        mock_db
            .expect_retrieve_message_by_nonce()
            .returning(move |nonce| {
                // return `None` the first time we get a query for the last message
                // (the `MAX_ONCHAIN_NONCE`th one), to simulate an ongoing indexing that hasn't finished
                if nonce == MAX_ONCHAIN_NONCE && retrieve_calls_for_max_onchain_nonce == 0 {
                    retrieve_calls_for_max_onchain_nonce += 1;
                    return Ok(None);
                }

                // otherwise return a message for every nonce in the closed
                // interval [0, MAX_ONCHAIN_NONCE]
                if nonce > MAX_ONCHAIN_NONCE {
                    Ok(None)
                } else {
                    Ok(Some(dummy_hyperlane_message(
                        &dummy_domain(1, "dummy_domain"),
                        nonce,
                    )))
                }
            });

        // The messages must be marked as "not processed" in the db for them to be returned
        // when the iterator queries them
        mock_db
            .expect_retrieve_processed_by_nonce()
            .returning(|_| Ok(Some(false)));
        let dummy_metrics = dummy_processor_metrics(0);
        let db = Arc::new(mock_db);

        let mut forward_backward_iterator = ForwardBackwardIterator::new(db.clone());

        let mut messages = vec![];
        while let Some(msg) = forward_backward_iterator
            .try_get_next_message(&dummy_metrics)
            .await
            .unwrap()
        {
            messages.push(msg.nonce);
        }

        // we start with 2 (MOCK_HIGHEST_SEEN_NONCE) as the highest seen nonce,
        // so we go forward and get 3.
        // then we try going forward again but get a `None` (not indexed yet), for nonce 4 (MAX_ONCHAIN_NONCE).
        // then we go backwards once and get 1.
        // then retry the forward iteration, which should return a message the second time, for nonce 4.
        // finally, going forward again returns None so we go backward and get 0.
        assert_eq!(messages, vec![2, 3, 1, 4, 0]);

        // the final bounds of the iterator are (None, MAX_ONCHAIN_NONCE + 1), where None means
        // the backward iterator has reached the beginning (iterated past nonce 0)
        assert_eq!(forward_backward_iterator.low_nonce_iter.nonce, None);
        assert_eq!(
            forward_backward_iterator.high_nonce_iter.nonce,
            Some(MAX_ONCHAIN_NONCE + 1)
        );
    }

    type ResponseList<T> = Arc<Mutex<VecDeque<T>>>;

    #[derive(Serialize)]
    pub struct MockMessage {
        pub message: PendingMessage,
        #[serde(skip)]
        pub prepare_responses: ResponseList<PendingOperationResult>,
    }

    impl Debug for MockMessage {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{:?}", self.message)
        }
    }

    #[async_trait::async_trait]
    #[typetag::serialize]
    impl PendingOperation for MockMessage {
        fn id(&self) -> H256 {
            self.message.id()
        }

        fn status(&self) -> PendingOperationStatus {
            self.message.status()
        }

        fn set_status(&mut self, status: PendingOperationStatus) {
            self.message.set_status(status)
        }

        fn priority(&self) -> u32 {
            self.message.priority()
        }

        fn origin_domain_id(&self) -> u32 {
            self.message.origin_domain_id()
        }

        fn destination_domain(&self) -> &HyperlaneDomain {
            self.message.destination_domain()
        }

        fn sender_address(&self) -> &H256 {
            self.message.sender_address()
        }

        fn recipient_address(&self) -> &H256 {
            self.message.recipient_address()
        }

        fn retrieve_status_from_db(&self) -> Option<PendingOperationStatus> {
            self.message.retrieve_status_from_db()
        }

        fn app_context(&self) -> Option<String> {
            self.message.app_context()
        }

        async fn prepare(&mut self) -> PendingOperationResult {
            self.prepare_responses
                .lock()
                .await
                .pop_front()
                .expect("No mock prepare response set")
        }

        async fn submit(&mut self) -> PendingOperationResult {
            PendingOperationResult::Reprepare(ReprepareReason::ErrorSubmitting)
        }

        fn set_submission_outcome(&mut self, outcome: TxOutcome) {
            self.message.set_submission_outcome(outcome)
        }

        fn get_tx_cost_estimate(&self) -> Option<U256> {
            self.message.get_tx_cost_estimate()
        }

        async fn confirm(&mut self) -> PendingOperationResult {
            self.message.confirm().await
        }

        fn set_operation_outcome(
            &mut self,
            submission_outcome: TxOutcome,
            submission_estimated_cost: U256,
        ) {
            self.message
                .set_operation_outcome(submission_outcome, submission_estimated_cost)
        }

        fn next_attempt_after(&self) -> Option<Instant> {
            self.message.next_attempt_after()
        }

        fn set_next_attempt_after(&mut self, delay: Duration) {
            self.message.set_next_attempt_after(delay)
        }

        fn reset_attempts(&mut self) {
            self.message.reset_attempts();
        }

        fn set_retries(&mut self, retries: u32) {
            self.message.set_retries(retries);
        }

        fn get_retries(&self) -> u32 {
            self.message.get_retries()
        }

        fn try_get_mailbox(&self) -> Option<Arc<dyn Mailbox>> {
            self.message.try_get_mailbox()
        }

        fn get_metric(&self) -> Option<Arc<IntGauge>> {
            self.message.get_metric()
        }

        fn set_metric(&mut self, metric: Arc<IntGauge>) {
            self.message.set_metric(metric)
        }

        async fn payload(&self) -> ChainResult<Vec<u8>> {
            self.message.payload().await
        }

        fn on_reprepare(
            &mut self,
            err: Option<String>,
            reason: ReprepareReason,
        ) -> PendingOperationResult {
            self.message.on_reprepare(err, reason)
        }
    }

    impl TryBatchAs<HyperlaneMessage> for MockMessage {
        fn try_batch(&self) -> ChainResult<BatchItem<HyperlaneMessage>> {
            self.message.try_batch()
        }
    }

    fn dummy_metrics_and_label() -> (IntGaugeVec, String) {
        (
            IntGaugeVec::new(
                prometheus::Opts::new("op_queue", "OpQueue metrics"),
                &[
                    "destination",
                    "queue_metrics_label",
                    "operation_status",
                    "app_context",
                ],
            )
            .unwrap(),
            "queue_metrics_label".to_string(),
        )
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_status_error() {
        let origin_domain = HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Arbitrum);
        let destination_domain =
            HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Arbitrum);

        let cache = OptionalCache::new(None);

        let temp_dir = PathBuf::from("/tmp/kamiyaa/rocksdb");
        let db = DB::from_path(temp_dir.as_path()).unwrap();
        let base_db = HyperlaneRocksDB::new(&origin_domain, db);
        /*
               let (message_processor, mut receive_channel) =
                   dummy_message_processor(&origin_domain, &destination_domain, &base_db, cache.clone());

               let processor = Processor::new(Box::new(message_processor), TaskMonitor::new());
               let process_fut = processor.spawn(info_span!("MessageProcessor"));
               let mut pending_messages = vec![];
               let pending_message_accumulator = async {
                   while let Some(pm) = receive_channel.recv().await {
                       eprintln!("DB Message: {:?}", pm);
                       pending_messages.push(pm);
                   }
               };
               tokio::select! {
                   _ = process_fut => {},
                   _ = pending_message_accumulator => {},
                   _ = sleep(Duration::from_millis(200)) => { panic!("No PendingMessage received from the processor") }
               };
        */

        let arb_chain_conf = ChainConf {
            domain: origin_domain.clone(),
            // TODO
            signer: None,
            submitter: SubmitterType::Classic,
            estimated_block_time: Duration::from_secs(1),
            reorg_period: ReorgPeriod::from_blocks(10),
            addresses: CoreContractAddresses {
                mailbox: H160::from_str("0x979Ca5202784112f4738403dBec5D0F3B9daabB9")
                    .unwrap()
                    .into(),
                validator_announce: H160::from_str("0x1df063280C4166AF9a725e3828b4dAC6c7113B08")
                    .unwrap()
                    .into(),
                ..Default::default()
            },
            connection: ChainConnectionConf::Ethereum(ConnectionConf {
                rpc_connection: RpcConnectionConf::HttpFallback {
                    urls: vec![
                        "https://arbitrum.drpc.org".parse().unwrap(),
                        "https://endpoints.omniatech.io/v1/arbitrum/one/public"
                            .parse()
                            .unwrap(),
                    ],
                },
                transaction_overrides: Default::default(),
                op_submission_config: OpSubmissionConfig {
                    batch_contract_address: None,
                    max_batch_size: 32,
                    bypass_batch_simulation: false,
                    ..Default::default()
                },
            }),
            metrics_conf: Default::default(),
            index: Default::default(),
        };

        // https://explorer.hyperlane.xyz/message/0x29160a18c6e27c2f14ebe021207ac3f90664507b9c5aacffd802b2afcc15788a
        // Base -> Arbitrum, uses the default ISM
        let message_bytes = hex::decode("0300139ebf000021050000000000000000000000005454cf5584939f7f884e95dba33fecd6d40b8fe20000a4b1000000000000000000000000fd34afdfbac1e47afc539235420e4be4a206f26d0000000000000000000000008650ee37ba2b0a8ac5954a04b46ee07093eab7f90000000000000000000000000000000000000000000000004563918244f40000").unwrap();
        let mut message = HyperlaneMessage::read_from(&mut &message_bytes[..]).unwrap();
        message.nonce = 0;
        message.origin = KnownHyperlaneDomain::Arbitrum as u32;
        message.destination = KnownHyperlaneDomain::Arbitrum as u32;

        let core_metrics = CoreMetrics::new("test", 9090, Default::default()).unwrap();
        let arb_mailbox: Arc<dyn Mailbox> = arb_chain_conf
            .build_mailbox(&core_metrics)
            .await
            .unwrap()
            .into();

        let base_va = Arc::new(MockValidatorAnnounceContract::default());
        let default_ism_getter = DefaultIsmCache::new(arb_mailbox.clone());
        let core_metrics = Arc::new(core_metrics);
        let base_metadata_builder = BaseMetadataBuilder::new(
            origin_domain.clone(),
            arb_chain_conf.clone(),
            Arc::new(RwLock::new(MerkleTreeBuilder::new())),
            base_va,
            false,
            core_metrics.clone(),
            cache.clone(),
            base_db.clone(),
            IsmAwareAppContextClassifier::new(default_ism_getter.clone(), vec![]),
            IsmCachePolicyClassifier::new(default_ism_getter, Default::default()),
        );
        let message_context = Arc::new(MessageContext {
            destination_mailbox: arb_mailbox,
            origin_db: Arc::new(base_db.clone()),
            cache,
            metadata_builder: Arc::new(base_metadata_builder),
            origin_gas_payment_enforcer: Arc::new(GasPaymentEnforcer::new([], base_db.clone())),
            transaction_gas_limit: Default::default(),
            metrics: dummy_submission_metrics(),
            application_operation_verifier: Some(Arc::new(DummyApplicationOperationVerifier {})),
        });
        let metadata =
        "0x000000100000001000000010000001680000000000000000000000100000015800000000000000000000000019dc38aeae620380430c200a6e990d5af5480117dbd3d5e656de9dcf604fcc90b52a3b97d9f3573b4a0733e824f1358e515698cf00139eaa5452e030aa937f6b14162a44ec3327f6832bbf16e4b0d6df452524af1c1a04e875b4ce7ac0da92aa08838a89f2a126eef23f6b6a08b6cdbe9e9e804b321088b91b034f9466eed2da1dcc36cb220b887b15f3e111a179142c27e4a0b6d6b7a291e22577d6296d82b7c3f29e8989ec1161d853aba0982b2db28b9a9917226c2c27111c41c99e6a84e7717740f901528062385e659b4330e7227593a334be532d27bcf24f3f13bf4fc1a860e96f8d6937984ea83ef61c8ea30d48cc903f6ff725406a4d1ce73f46064b3403ea4c720b770f4389d7259b275f085c6a98cef9a04880a249b42c382ba34a63031debbfb5b9b232ffd9ee45ff63a7249e83c7e9720f9e978a431b".as_bytes().to_vec();

        let mut pending_message = PendingMessage::new(
            message.clone(),
            message_context.clone(),
            PendingOperationStatus::FirstPrepareAttempt,
            Some(format!("test-{}", 0)),
            2,
        );
        pending_message.submission_data = Some(Box::new(MessageSubmissionData {
            metadata: metadata.clone(),
            gas_limit: U256::from(615293),
        }));

        //        let res = base_db.store_message(&pending_message.message, 0);
        //        println!("Store RES: {:?}", res);

        let vec_deque: VecDeque<_> = [
            PendingOperationResult::Success,
            PendingOperationResult::Reprepare(ReprepareReason::ErrorEstimatingGas),
            /*
            PendingOperationResult::Success,
            PendingOperationResult::Reprepare(ReprepareReason::ErrorEstimatingGas),
            PendingOperationResult::Success,
            PendingOperationResult::Reprepare(ReprepareReason::ErrorEstimatingGas),
             */
        ]
        .into_iter()
        .collect();

        let message = MockMessage {
            message: pending_message,
            prepare_responses: Arc::new(Mutex::new(vec_deque)),
        };

        let broadcaster = tokio::sync::broadcast::Sender::new(100);

        let receiver = Arc::new(Mutex::new(broadcaster.subscribe()));
        let (metrics, _) = dummy_metrics_and_label();
        let prepare_queue = OpQueue::new(metrics.clone(), "prepare".into(), receiver.clone());
        let submit_queue = OpQueue::new(metrics.clone(), "submit".into(), receiver.clone());
        let confirm_queue = OpQueue::new(metrics.clone(), "confirm".into(), receiver.clone());

        let submitter_queue_length = register_int_gauge_vec!(
            opts!("submitter_queue_length", "Submitter queue length",),
            &["remote", "queue_name", "operation_status", "app_context"],
        )
        .unwrap();
        let operations_processed_count = IntCounter::new(
            "operations_processed_count",
            "Number of operations processed",
        )
        .unwrap();

        let serial_submitter_metrics = SerialSubmitterMetrics {
            submitter_queue_length,
            ops_confirmed: operations_processed_count.clone(),
            ops_dropped: operations_processed_count.clone(),
            ops_failed: operations_processed_count.clone(),
            ops_prepared: operations_processed_count.clone(),
            ops_submitted: operations_processed_count.clone(),
        };

        prepare_queue
            .push(
                Box::new(message),
                Some(PendingOperationStatus::FirstPrepareAttempt),
            )
            .await;

        let prepare_task = tokio::task::Builder::new()
            .spawn(prepare_classic_task(
                origin_domain.clone(),
                prepare_queue.clone(),
                submit_queue.clone(),
                confirm_queue.clone(),
                10,
                None,
                serial_submitter_metrics.clone(),
            ))
            .unwrap();

        let submit_task = tokio::task::Builder::new()
            .spawn(submit_classic_task(
                origin_domain.clone(),
                prepare_queue.clone(),
                submit_queue.clone(),
                confirm_queue.clone(),
                10,
                serial_submitter_metrics.clone(),
            ))
            .unwrap();

        let confirm_task = tokio::task::Builder::new()
            .spawn(confirm_classic_task(
                origin_domain.clone(),
                prepare_queue.clone(),
                confirm_queue.clone(),
                10,
                serial_submitter_metrics.clone(),
            ))
            .unwrap();
        /*
               let receive_task = tokio::task::Builder::new()
                   .spawn(receive_task(
                       domain.clone(),
                       receive_channel,
                       prepare_queue.clone(),
                   )).unwrap();
        */

        let tasks = [prepare_task, submit_task, confirm_task];

        if let Err(err) = try_join_all(tasks).await {
            eprintln!("Error {:?}", err);
        }
    }
}
