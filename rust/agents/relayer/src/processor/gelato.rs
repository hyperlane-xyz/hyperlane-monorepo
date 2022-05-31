use abacus_core::{accumulator::merkle::Proof, AbacusMessage};
use async_trait::async_trait;

use super::{MessageProcessingStatus, Processor};

pub struct GelatoMessageProcessor {}

impl GelatoMessageProcessor {
    #[allow(dead_code)]
    pub(crate) fn new() -> Self {
        Self {}
    }
}

#[async_trait]
impl Processor for GelatoMessageProcessor {
    async fn process(&self, _message: &AbacusMessage, _proof: &Proof) -> MessageProcessingStatus {
        // TODO actually submit to Gelato here
        MessageProcessingStatus::Unprocessed
    }
}
