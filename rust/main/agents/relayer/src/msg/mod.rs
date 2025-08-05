#![allow(clippy::doc_lazy_continuation)] // TODO: `rustc` 1.80.1 clippy issue

//! DbLoader scans DB for new messages and wraps relevant messages as a
//! `PendingOperation` and then sends it over a channel to the processor for
//! delivery.
//!
//! Pending operations have three steps for execution, `prepare`, `submit`, and
//! `confirm` The `prepare` step is used to do any read-only blockchain
//! calls that are needed to determine if the operation is ready to be submitted
//! and to get the data required to actually submit it. The `submit` step is
//! used to actually submit the transaction to the blockchain. The `confirm`
//! step is used to validate the transaction survived the reorg window.
//!
//! Creating this separation between `prepare` and `submit` enables preparing
//! one operation while waiting for another to be submitted; and then `confirm`
//! allows us to re-run the operation if it succeeded but did not actually end
//! up getting included.

pub(crate) mod blacklist;
pub(crate) mod db_loader;
pub(crate) mod gas_payment;
pub(crate) mod message_processor;
pub(crate) mod metadata;
pub(crate) mod op_batch;
pub(crate) mod op_queue;
mod utils;

pub mod pending_message;

pub use gas_payment::GAS_EXPENDITURE_LOG_MESSAGE;
