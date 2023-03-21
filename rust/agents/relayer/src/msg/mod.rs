//! Processor scans DB for new messages and sends relevant messages
//! over a channel to a submitter, for delivery.
//!
//! A submitter uses some strategy to try to deliver those messages
//! to the target blockchain.
//!
//! Right now there is one strategy: serial.
//!
//! In the future it could make sense for there to be more, some ideas are:
//!   - BatchingMessagesSubmitter
//!   - ShardedWalletSubmitter (to get parallelism / nonce)
//!   - SpeculativeSerializedSubmitter (batches with higher optimistic nonces,
//!     recovery behavior)
//!   - FallbackProviderSubmitter (Serialized, but if some RPC provider sucks,
//!   switch everyone to new one)

use std::cmp::Ordering;
use std::fmt::{Debug, Formatter};
use std::time::Instant;

use derive_new::new;

use hyperlane_core::HyperlaneMessage;

pub mod gas_payment;
pub mod metadata_builder;
pub mod processor;
pub mod serial_submitter;

/// A SubmitMessageOp describes the message that the submitter should
/// try to submit.
#[derive(Clone, new)]
pub(crate) struct SubmitMessageArgs {
    pub message: HyperlaneMessage,
    #[new(default)]
    num_retries: u32,
    #[new(value = "Instant::now()")]
    last_attempted_at: Instant,
    #[new(default)]
    next_attempt_after: Option<Instant>,
}

impl Debug for SubmitMessageArgs {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        let now = Instant::now();
        let as_secs = |t| {
            now.duration_since(t).as_secs()
        };
        write!(f, "SubmitMessageArgs {{ num_retires: {}, since_last_attempt_s: {}, next_attempt_after_s: {}, message: {:?} }}",
               self.num_retries, as_secs(self.last_attempted_at), self.next_attempt_after.map(as_secs).unwrap_or(0), self.message)
    }
}

/// Sort by their next allowed attempt time and if no allowed time is set, then
/// put it in front of those with a time (they have been tried before) and break
/// ties between ones that have not been tried with the nonce.
impl Ord for SubmitMessageArgs {
    fn cmp(&self, other: &Self) -> Ordering {
        use Ordering::*;
        match (&self.next_attempt_after, &other.next_attempt_after) {
            (Some(s), Some(o)) => s.cmp(o),
            (Some(_), None) => Greater,
            (None, Some(_)) => Less,
            (None, None) => self.message.nonce.cmp(&other.message.nonce),
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
