#![deny(clippy::unwrap_used, clippy::panic)]
#![deny(clippy::arithmetic_side_effects)]

pub use adapter::AdaptsChainAction;
pub use dispatcher::command_entrypoint::CommandEntrypoint;
pub use dispatcher::entrypoint::{DispatcherEntrypoint, Entrypoint};
pub use dispatcher::{DatabaseOrPath, Dispatcher, DispatcherMetrics, DispatcherSettings};
pub use error::LanderError;
pub use payload::{
    DropReason as PayloadDropReason, FullPayload, PayloadStatus, PayloadUuid,
    RetryReason as PayloadRetryReason,
};
pub use transaction::{DropReason as TransactionDropReason, TransactionStatus, TransactionUuid};

mod adapter;
mod dispatcher;
mod error;
mod payload;
mod transaction;

#[cfg(test)]
mod tests;

#[cfg(feature = "integration_test")]
mod testing;

// Re-export internal types needed for integration tests (hidden from public docs)
// These are required by the integration test factory functions and trait bounds
#[cfg(feature = "integration_test")]
#[doc(hidden)]
pub use adapter::AdaptsChain;
#[cfg(feature = "integration_test")]
#[doc(hidden)]
pub use dispatcher::{PayloadDb, TransactionDb};

// Re-export integration test factory functions
#[cfg(feature = "integration_test")]
#[doc(hidden)]
pub use testing::{create_test_dispatcher, create_test_sealevel_adapter};
