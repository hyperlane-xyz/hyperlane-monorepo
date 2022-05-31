use std::sync::Arc;

use abacus_base::CachingInbox;
use abacus_core::{accumulator::merkle::Proof, AbacusMessage, Inbox};
use async_trait::async_trait;
use tracing::info;

use super::{MessageProcessingStatus, Processor};

pub struct DirectMessageProcessor {
    inbox: Arc<CachingInbox>,
}

impl DirectMessageProcessor {
    pub(crate) fn new(inbox: Arc<CachingInbox>) -> Self {
        Self { inbox }
    }
}

#[async_trait]
impl Processor for DirectMessageProcessor {
    async fn process(&self, message: &AbacusMessage, proof: &Proof) -> MessageProcessingStatus {
        match self.inbox.process(message, proof).await {
            Ok(outcome) => {
                info!(
                    leaf_index = proof.index,
                    hash = ?outcome.txid,
                    "[DirectMessageProcessor] processed"
                );
                MessageProcessingStatus::Processed
            }
            Err(err) => MessageProcessingStatus::Error(eyre::Report::new(err)),
        }
    }
}
