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
#[cfg(test)]
mod tests;
mod transaction;

// Re-export test utilities and internal types for integration tests (hidden from public docs)
// Note: Only compiled during test builds when dev-dependencies are available
#[cfg(test)]
#[path = "tests/test_utils.rs"]
#[doc(hidden)]
pub mod test_utils;

#[doc(hidden)]
pub use adapter::{AdaptsChain, GasLimit, TxBuildingResult};
#[doc(hidden)]
pub use dispatcher::{PayloadDb, TransactionDb};
#[doc(hidden)]
pub use payload::PayloadDetails;
#[doc(hidden)]
pub use transaction::{Transaction, VmSpecificTxData};

/// Create a dispatcher and entrypoint for testing purposes
///
/// This factory function hides internal dispatcher construction details from integration tests.
/// It creates both the entrypoint (for sending payloads and checking status) and the dispatcher
/// (for spawning background workers).
///
/// # Arguments
/// * `adapter` - Chain-specific adapter for building and submitting transactions
/// * `payload_db` - Database for storing payloads
/// * `tx_db` - Database for storing transactions
/// * `domain` - Name of the destination chain (used for logging)
///
/// # Returns
/// A tuple of (DispatcherEntrypoint, Dispatcher) ready for use in tests
#[doc(hidden)]
pub async fn create_test_dispatcher(
    adapter: std::sync::Arc<dyn AdaptsChain>,
    payload_db: std::sync::Arc<dyn PayloadDb>,
    tx_db: std::sync::Arc<dyn TransactionDb>,
    domain: String,
) -> (DispatcherEntrypoint, Dispatcher) {
    use dispatcher::DispatcherState;

    let metrics = DispatcherMetrics::dummy_instance();
    let state = DispatcherState::new(payload_db, tx_db, adapter, metrics, domain.clone());
    let entrypoint = DispatcherEntrypoint::from_inner(state.clone());
    let dispatcher = Dispatcher::from_inner(state, domain);
    (entrypoint, dispatcher)
}
