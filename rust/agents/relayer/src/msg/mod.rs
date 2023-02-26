use std::cmp::Ordering;
use std::time::Instant;

use derive_new::new;

use hyperlane_core::HyperlaneMessage;

pub mod gas_payment;
pub mod gelato_submitter;
pub mod metadata_builder;
pub mod processor;
pub mod serial_submitter;

/// Processor scans DB for new messages and sends relevant messages
/// over a channel to a submitter, for delivery.
///
/// A submitter uses some strategy to try to deliver those messages
/// to the target blockchain.
///
/// A SubmitMessageOp describes the message that the submitter should
/// try to submit.
///
/// Right now there are two strategies: serial and Gelato.
///
/// In the future it could make sense for there to be more, some ideas are:
///   - BatchingMessagesSubmitter
///   - ShardedWalletSubmitter (to get parallelism / nonce)
///   - SpeculativeSerializedSubmitter (batches with higher optimistic
///     nonces, recovery behavior)
///   - FallbackProviderSubmitter (Serialized, but if some RPC provider sucks,
///   switch everyone to new one)

#[derive(Clone, Debug, new)]
pub struct SubmitMessageArgs {
    pub message: HyperlaneMessage,
    #[new(default)]
    num_retries: u32,
    #[new(value = "Instant::now()")]
    last_attempted_at: Instant,
}

// The run_queue implementation is a max-heap.  We want the next op to
// be min over <num_retries, nonce>, so the total ordering is
// the reverse of the natural lexicographic ordering.
//
// TODO(webbhorn): It may be more natural to take a `Reversed` of the normal
// or implicit sort order of the `SubmitMessageArgs` struct. It also may be appropriate
// to either wrap in a Schedulable or impl a Schedulable trait.
impl Ord for SubmitMessageArgs {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.num_retries.cmp(&other.num_retries) {
            Ordering::Equal => match self.message.nonce.cmp(&other.message.nonce) {
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
        self.num_retries == other.num_retries && self.message.nonce == other.message.nonce
    }
}

impl Eq for SubmitMessageArgs {}
