use std::cmp::Ordering;

use abacus_core::{accumulator::merkle::Proof, CommittedMessage, MultisigSignedCheckpoint};

use tokio::time::Instant;

pub mod forward_request_op;
pub mod gas_oracle;
pub mod gelato_submitter;
pub mod message_status;
pub mod processor;
pub mod serial_submitter;

#[derive(Clone, Debug)]
pub struct SubmitMessageArgs {
    pub leaf_index: u32,
    pub committed_message: CommittedMessage,
    pub checkpoint: MultisigSignedCheckpoint,
    pub proof: Proof,
    pub enqueue_time: Instant,
    num_retries: u32,
}

impl SubmitMessageArgs {
    pub fn new(
        leaf_index: u32,
        committed_message: CommittedMessage,
        checkpoint: MultisigSignedCheckpoint,
        proof: Proof,
        enqueue_time: Instant,
    ) -> Self {
        SubmitMessageArgs {
            leaf_index,
            committed_message,
            checkpoint,
            proof,
            enqueue_time,
            num_retries: 0,
        }
    }
}

impl Ord for SubmitMessageArgs {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.num_retries.cmp(&other.num_retries) {
            Ordering::Equal => match self.leaf_index.cmp(&other.leaf_index) {
                Ordering::Equal => Ordering::Equal,
                Ordering::Less => Ordering::Greater,
                Ordering::Greater => Ordering::Less,
            },
            Ordering::Less => Ordering::Greater,
            Ordering::Greater => Ordering::Less,
        }
    }
}

impl PartialOrd for SubmitMessageArgs {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for SubmitMessageArgs {
    fn eq(&self, other: &Self) -> bool {
        self.num_retries == other.num_retries && self.leaf_index == other.leaf_index
    }
}

impl Eq for SubmitMessageArgs {}
