use std::cmp::Ordering;

use abacus_core::{accumulator::merkle::Proof, CommittedMessage, MultisigSignedCheckpoint};

use tokio::time::Instant;

pub mod gelato_submitter;
pub mod processor;
pub mod serial_submitter;

/// processor scans DB for new messages and sends relevant messages
/// over a channel to a submitter, for delivery.
///
/// a submitter uses some strategy to try to delivery those messages
/// to the target blockchain.
///
/// a SubmitMessageOp describes the message that the submitter should
/// try to submit.
///
/// right now there are two strategies: serial and gelato.
///
/// in the future it could make sense for there to be more, some ideas are:
///   - BatchingMessagesSubmitter
///   - ShardedWalletSubmitter (to get parallelism / nonce)
///   - SpeculativeSerializedSubmitter (batches with higher optimistic
///     nonces, recovery behavior)
///   - FallbackProviderSubmitter (Serialized, but if some RPC provider sucks,
///   switch everyone to new one)

#[derive(Clone, Debug)]
pub struct SubmitMessageArgs {
    pub leaf_index: u32,
    pub committed_message: CommittedMessage,
    pub checkpoint: MultisigSignedCheckpoint,
    pub proof: Proof,
    pub num_retries: u32,
    pub enqueue_time: Instant,
}

// The runqueue implementation is a max-heap.  We want the next op to
// be min over <num_retries, leaf_index>, so the total ordering is
// the reverse of the natural lexicographic ordering.
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
