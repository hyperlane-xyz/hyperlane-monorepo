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

#[derive(Clone, Debug, Default, Eq, PartialEq, PartialOrd, Ord)]
pub struct SubmitMessageOp {
    pub leaf_index: u32,
}

#[allow(dead_code)]
#[derive(Debug)]
enum MessageProcessingStatus {
    NotDestinedForInbox,
    NotWhitelisted,
    NotYetCheckpointed,
    Processed,
    Error,
}
