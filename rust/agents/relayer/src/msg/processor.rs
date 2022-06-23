use std::sync::Arc;

use eyre::{bail, Result};
use prometheus::IntGauge;
use tokio::{sync::mpsc, task::JoinHandle};
use tracing::{info, info_span, instrument, instrument::Instrumented, warn, Instrument};

use abacus_base::{CoreMetrics, InboxContracts, Outboxes};
use abacus_core::{
    db::AbacusDB, AbacusCommon, AbacusContract, ChainCommunicationError, CommittedMessage, Inbox,
    InboxValidatorManager, MessageStatus, MultisigSignedCheckpoint, Outbox, OutboxState,
};

use crate::merkle_tree_builder::MerkleTreeBuilder;
use crate::msg::SubmitMessageOp;
use crate::settings::whitelist::Whitelist;

#[derive(Debug)]
pub(crate) struct MessageProcessor {
    outbox: Outboxes,
    db: AbacusDB,
    inbox_contracts: InboxContracts,
    whitelist: Arc<Whitelist>,
    metrics: MessageProcessorMetrics,
    tx_msg: mpsc::Sender<SubmitMessageOp>,
}

impl MessageProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        outbox: Outboxes,
        db: AbacusDB,
        inbox_contracts: InboxContracts,
        whitelist: Arc<Whitelist>,
        metrics: MessageProcessorMetrics,
        tx_msg: mpsc::Sender<SubmitMessageOp>,
    ) -> Self {
        Self {
            outbox,
            db,
            inbox_contracts,
            whitelist,
            metrics,
            tx_msg,
        }
    }

    pub(crate) fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MessageProcessor");
        tokio::spawn(self.main_loop()).instrument(span)
    }
    #[instrument(ret, err, skip(self), fields(inbox_name=self.inbox_contracts.inbox.chain_name()), level = "info")]
    async fn main_loop(mut self) -> Result<()> {
        let mut message_leaf_index = 0;
        loop {
            self.update_outbox_state_gauge();
            self.metrics
                .processor_loop_gauge
                .set(message_leaf_index as i64);

            info!("now have message index {}", message_leaf_index);

            // Scan until we find next index without delivery confirmation.
            if self
                .db
                .retrieve_leaf_processing_status(message_leaf_index)?
                .is_some()
            {
                message_leaf_index += 1;
                continue;
            }
            let message = if let Some(msg) = self
                .db
                .message_by_leaf_index(message_leaf_index)?
                .map(CommittedMessage::try_from)
                .transpose()?
            {
                msg
            } else {
                warn!("leaf in db without message idx: {}", message_leaf_index);
                // Not clear what the best thing to do here is, but there is
                // seemingly an existing race wherein an indexer might non-atomically
                // write leaf info to rocksdb across a few records, so we might see
                // the leaf status above, but not the message contents here.
                // For now, optimistically sleep and then re-enter the loop in opes
                // that the DB is now coherent.
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            };

            // Skip if for different inbox.
            if message.message.destination != self.inbox_contracts.inbox.local_domain() {
                info!(
                    inbox_name=?self.inbox_contracts.inbox.chain_name(),
                    local_domain=?self.inbox_contracts.inbox.local_domain(),
                    dst=?message.message.destination,
                    msg=?message,
                    "message not for local domain, skipping idx {}", message_leaf_index);
                message_leaf_index += 1;
                continue;
            }

            // Skip if not whitelisted.
            if !self.whitelist.msg_matches(&message.message) {
                info!(
                    inbox_name=?self.inbox_contracts.inbox.chain_name(),
                    local_domain=?self.inbox_contracts.inbox.local_domain(),
                    dst=?message.message.destination,
                    whitelist=?self.whitelist,
                    msg=?message,
                    "message not whitelisted, skipping idx {}", message_leaf_index);
                message_leaf_index += 1;
                continue;
            }

            if self.db.leaf_by_leaf_index(message_leaf_index)?.is_some() {
                info!("sending message at idx {} to submitter", message_leaf_index);
                self.tx_msg
                    .send(SubmitMessageOp {
                        leaf_index: message_leaf_index,
                        num_retries: 0,
                    })
                    .await?;
                message_leaf_index += 1;
                continue;
            }
        }
    }

    /// Spawn a task to update the outbox state gauge.
    fn update_outbox_state_gauge(
        &self,
    ) -> JoinHandle<Result<OutboxState, ChainCommunicationError>> {
        let outbox_state_gauge = self.metrics.outbox_state_gauge.clone();
        let outbox = self.outbox.clone();
        tokio::spawn(async move {
            let state = outbox.state().await;
            match &state {
                Ok(state) => outbox_state_gauge.set(*state as u8 as i64),
                Err(e) => warn!(error = %e, "Failed to get outbox state"),
            };
            state
        })
    }
}

#[derive(Debug)]
pub(crate) struct MessageProcessorMetrics {
    processor_loop_gauge: IntGauge,
    processed_gauge: IntGauge,
    retry_queue_length_gauge: IntGauge,
    outbox_state_gauge: IntGauge,
}

impl MessageProcessorMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str, inbox_chain: &str) -> Self {
        Self {
            processor_loop_gauge: metrics.last_known_message_leaf_index().with_label_values(&[
                "processor_loop",
                outbox_chain,
                inbox_chain,
            ]),
            processed_gauge: metrics.last_known_message_leaf_index().with_label_values(&[
                "message_processed",
                outbox_chain,
                inbox_chain,
            ]),
            outbox_state_gauge: metrics.outbox_state().with_label_values(&[outbox_chain]),
            retry_queue_length_gauge: metrics
                .retry_queue_length()
                .with_label_values(&[outbox_chain, inbox_chain]),
        }
    }
}
