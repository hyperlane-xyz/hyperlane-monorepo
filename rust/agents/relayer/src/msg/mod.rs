//! Processor scans DB for new messages and wraps relevant messages as a
//! `PendingOperation` and then sends it over a channel to a submitter for
//! delivery.
//!
//! A submitter uses some strategy to try to execute the pending operations.
//! Pending operations have two steps for execution, a `prepare` step and a
//! `submit` step. The `prepare` step is used to do any read-only blockchain
//! calls that are needed to determine if the operation is ready to be submitted
//! and to get the data required to actually submit it. The `submit` step is
//! used to actually submit the transaction to the blockchain.
//!
//! Creating this separation between `prepare` and `submit` enables preparing
//! one operation while waiting for another to be submitted.
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

pub mod gas_payment;
pub mod metadata;
pub mod pending_message;
pub mod pending_operation;
pub mod processor;
pub mod serial_submitter;
