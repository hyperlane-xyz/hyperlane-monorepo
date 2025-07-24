#![deny(clippy::unwrap_used, clippy::panic)]

pub use dispatcher::entrypoint::{DispatcherEntrypoint, Entrypoint};
pub use dispatcher::{DatabaseOrPath, Dispatcher, DispatcherMetrics, DispatcherSettings};
pub use error::LanderError;
pub use payload::{
    DropReason as PayloadDropReason, FullPayload, PayloadStatus, PayloadUuid,
    RetryReason as PayloadRetryReason,
};
pub use transaction::{DropReason as TransactionDropReason, TransactionStatus};

mod adapter;
mod dispatcher;
mod error;
mod payload;
#[cfg(test)]
mod tests;
mod transaction;
