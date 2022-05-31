use abacus_core::{accumulator::merkle::Proof, AbacusMessage};
use async_trait::async_trait;

use super::MessageProcessingStatus;

#[async_trait]
pub(crate) trait Processor {
    async fn process(&self, message: &AbacusMessage, proof: &Proof) -> MessageProcessingStatus;
}
