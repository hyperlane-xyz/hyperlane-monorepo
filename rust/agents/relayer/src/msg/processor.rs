use std::{
    collections::HashMap,
    fmt::{Debug, Formatter},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use hyperlane_base::{db::HyperlaneRocksDB, CoreMetrics};
use hyperlane_core::{HyperlaneDomain, HyperlaneMessage};
use prometheus::IntGauge;
use tokio::sync::mpsc::UnboundedSender;
use tracing::{debug, trace};

use super::{metadata::AppContextClassifier, op_queue::QueueOperation, pending_message::*};
use crate::{processor::ProcessorExt, settings::matching_list::MatchingList};

/// Finds unprocessed messages from an origin and submits then through a channel
/// for to the appropriate destination.
#[allow(clippy::too_many_arguments)]
#[derive(new)]
pub struct MessageProcessor {
    db: HyperlaneRocksDB,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    metrics: MessageProcessorMetrics,
    /// channel for each destination chain to send operations (i.e. message
    /// submissions) to
    send_channels: HashMap<u32, UnboundedSender<QueueOperation>>,
    /// Needed context to send a message for each destination chain
    destination_ctxs: HashMap<u32, Arc<MessageContext>>,
    metric_app_contexts: Vec<(MatchingList, String)>,
    #[new(default)]
    message_nonce: u32,
}

impl Debug for MessageProcessor {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MessageProcessor {{ whitelist: {:?}, blacklist: {:?}, message_nonce: {:?} }}",
            self.whitelist, self.blacklist, self.message_nonce
        )
    }
}

#[async_trait]
impl ProcessorExt for MessageProcessor {
    /// The domain this processor is getting messages from.
    fn domain(&self) -> &HyperlaneDomain {
        self.db.domain()
    }

    /// One round of processing, extracted from infinite work loop for
    /// testing purposes.
    async fn tick(&mut self) -> Result<()> {
        // Forever, scan HyperlaneRocksDB looking for new messages to send. When criteria are
        // satisfied or the message is disqualified, push the message onto
        // self.tx_msg and then continue the scan at the next highest
        // nonce.
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

            // Skip if the message is intended for this origin
            if destination == self.domain().id() {
                debug!(?msg, "Message destined for self, skipping");
                self.message_nonce += 1;
                return Ok(());
            }

            // Skip if the message is intended for a destination we do not service
            if !self.send_channels.contains_key(&destination) {
                debug!(?msg, "Message destined for unknown domain, skipping");
                self.message_nonce += 1;
                return Ok(());
            }

            debug!(%msg, "Sending message to submitter");

            let app_context_classifier =
                AppContextClassifier::new(self.metric_app_contexts.clone());

            let app_context = app_context_classifier.get_app_context(&msg).await?;
            // Finally, build the submit arg and dispatch it to the submitter.
            let pending_msg = PendingMessage::from_persisted_retries(
                msg,
                self.destination_ctxs[&destination].clone(),
                app_context,
            );
            self.send_channels[&destination].send(Box::new(pending_msg) as QueueOperation)?;
            self.message_nonce += 1;
        } else {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Ok(())
    }
}

impl MessageProcessor {
    fn try_get_unprocessed_message(&mut self) -> Result<Option<HyperlaneMessage>> {
        loop {
            // First, see if we can find the message so we can update the gauge.
            if let Some(message) = self.db.retrieve_message_by_nonce(self.message_nonce)? {
                // Update the latest nonce gauges
                self.metrics
                    .max_last_known_message_nonce_gauge
                    .set(message.nonce as i64);
                if let Some(metrics) = self.metrics.get(message.destination) {
                    metrics.set(message.nonce as i64);
                }

                // If this message has already been processed, on to the next one.
                if !self
                    .db
                    .retrieve_processed_by_nonce(&self.message_nonce)?
                    .unwrap_or(false)
                {
                    return Ok(Some(message));
                } else {
                    debug!(nonce=?self.message_nonce, "Message already marked as processed in DB");
                    self.message_nonce += 1;
                }
            } else {
                trace!(nonce=?self.message_nonce, "No message found in DB for nonce");
                return Ok(None);
            }
        }
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

#[cfg(test)]
mod test {
    use std::time::Instant;

    use crate::{
        merkle_tree::builder::MerkleTreeBuilder,
        msg::{
            gas_payment::GasPaymentEnforcer,
            metadata::{BaseMetadataBuilder, IsmAwareAppContextClassifier},
        },
        processor::Processor,
    };

    use super::*;
    use hyperlane_base::{
        db::{test_utils, HyperlaneRocksDB},
        settings::{ChainConf, ChainConnectionConf, Settings},
    };
    use hyperlane_test::mocks::{MockMailboxContract, MockValidatorAnnounceContract};
    use prometheus::{IntCounter, Registry};
    use tokio::{
        sync::{
            mpsc::{self, UnboundedReceiver},
            RwLock,
        },
        time::sleep,
    };

    fn dummy_processor_metrics(domain_id: u32) -> MessageProcessorMetrics {
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

    fn dummy_submission_metrics() -> MessageSubmissionMetrics {
        MessageSubmissionMetrics {
            last_known_nonce: IntGauge::new("last_known_nonce_gauge", "help string").unwrap(),
            messages_processed: IntCounter::new("message_processed_gauge", "help string").unwrap(),
        }
    }

    fn dummy_chain_conf(domain: &HyperlaneDomain) -> ChainConf {
        ChainConf {
            domain: domain.clone(),
            signer: Default::default(),
            reorg_period: Default::default(),
            addresses: Default::default(),
            connection: ChainConnectionConf::Ethereum(hyperlane_ethereum::ConnectionConf {
                rpc_connection: hyperlane_ethereum::RpcConnectionConf::Http {
                    url: "http://example.com".parse().unwrap(),
                },
                transaction_overrides: Default::default(),
            }),
            metrics_conf: Default::default(),
            index: Default::default(),
        }
    }

    fn dummy_metadata_builder(
        origin_domain: &HyperlaneDomain,
        destination_domain: &HyperlaneDomain,
        db: &HyperlaneRocksDB,
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
        BaseMetadataBuilder::new(
            origin_domain.clone(),
            destination_chain_conf.clone(),
            Arc::new(RwLock::new(MerkleTreeBuilder::new())),
            Arc::new(MockValidatorAnnounceContract::default()),
            false,
            Arc::new(core_metrics),
            db.clone(),
            5,
            IsmAwareAppContextClassifier::new(Arc::new(MockMailboxContract::default()), vec![]),
        )
    }

    fn dummy_message_processor(
        origin_domain: &HyperlaneDomain,
        destination_domain: &HyperlaneDomain,
        db: &HyperlaneRocksDB,
    ) -> (MessageProcessor, UnboundedReceiver<QueueOperation>) {
        let base_metadata_builder = dummy_metadata_builder(origin_domain, destination_domain, db);
        let message_context = Arc::new(MessageContext {
            destination_mailbox: Arc::new(MockMailboxContract::default()),
            origin_db: db.clone(),
            metadata_builder: Arc::new(base_metadata_builder),
            origin_gas_payment_enforcer: Arc::new(GasPaymentEnforcer::new([], db.clone())),
            transaction_gas_limit: Default::default(),
            metrics: dummy_submission_metrics(),
        });

        let (send_channel, receive_channel) = mpsc::unbounded_channel::<QueueOperation>();
        (
            MessageProcessor::new(
                db.clone(),
                Default::default(),
                Default::default(),
                dummy_processor_metrics(origin_domain.id()),
                HashMap::from([(destination_domain.id(), send_channel)]),
                HashMap::from([(destination_domain.id(), message_context)]),
                vec![],
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

    fn dummy_domain(domain_id: u32, name: &str) -> HyperlaneDomain {
        let test_domain = HyperlaneDomain::new_test_domain(name);
        HyperlaneDomain::Unknown {
            domain_id,
            domain_name: name.to_owned(),
            domain_type: test_domain.domain_type(),
            domain_protocol: test_domain.domain_protocol(),
            domain_technical_stack: test_domain.domain_technical_stack(),
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
        num_operations: usize,
    ) -> Vec<QueueOperation> {
        let (message_processor, mut receive_channel) =
            dummy_message_processor(origin_domain, destination_domain, db);

        let processor = Processor::new(Box::new(message_processor));
        let process_fut = processor.spawn();
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

    #[tokio::test]
    async fn test_full_pending_message_persistence_flow() {
        test_utils::run_test_db(|db| async move {
            let origin_domain = dummy_domain(0, "dummy_origin_domain");
            let destination_domain = dummy_domain(1, "dummy_destination_domain");
            let db = HyperlaneRocksDB::new(&origin_domain, db);

            // Assume the message syncer stored some new messages in HyperlaneDB
            let msg_retries = vec![0, 0, 0];
            persist_retried_messages(&msg_retries, &db, &destination_domain);

            // Run parser to load the messages in memory
            let pending_messages = get_first_n_operations_from_processor(
                &origin_domain,
                &destination_domain,
                &db,
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
                    let expected_backoff = PendingMessage::calculate_msg_backoff(*expected_retries)
                        .map(|b| b.as_secs_f32().round());
                    let actual_backoff = pm.next_attempt_after().map(|instant| {
                        instant.duration_since(Instant::now()).as_secs_f32().round()
                    });
                    assert_eq!(expected_backoff, actual_backoff);
                });
        })
        .await;
    }
}
