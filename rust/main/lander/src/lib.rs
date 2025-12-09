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

// Re-export internal types needed for integration tests (hidden from public docs)
// These are required by the integration test factory functions and trait bounds
#[doc(hidden)]
#[cfg(feature = "integration_test")]
pub use adapter::AdaptsChain;
#[doc(hidden)]
#[cfg(feature = "integration_test")]
pub use dispatcher::{PayloadDb, TransactionDb};

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
///
/// # Note
/// This function is only available when the `integration_test` feature is enabled.
/// Production builds should not enable this feature.
#[doc(hidden)]
#[cfg(feature = "integration_test")]
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

/// Create a Sealevel adapter for testing purposes
///
/// This factory function allows integration tests to create a Sealevel adapter
/// with mocked providers without needing to access internal constructors.
///
/// # Arguments
/// * `client` - Mock RPC client implementing SubmitSealevelRpc
/// * `provider` - Mock provider implementing SealevelProviderForLander
/// * `oracle` - Mock priority fee oracle
/// * `submitter` - Mock transaction submitter
/// * `estimated_block_time` - Block time for the adapter
///
/// # Returns
/// A SealevelAdapter configured for testing
///
/// # Note
/// This function is only available when the `integration_test` feature is enabled.
/// Production builds should not enable this feature.
#[doc(hidden)]
#[cfg(feature = "integration_test")]
pub fn create_test_sealevel_adapter(
    client: std::sync::Arc<dyn hyperlane_sealevel::fallback::SubmitSealevelRpc>,
    provider: std::sync::Arc<dyn hyperlane_sealevel::SealevelProviderForLander>,
    oracle: std::sync::Arc<dyn hyperlane_sealevel::PriorityFeeOracle>,
    submitter: std::sync::Arc<dyn hyperlane_sealevel::TransactionSubmitter>,
    estimated_block_time: std::time::Duration,
) -> std::sync::Arc<dyn AdaptsChain> {
    use adapter::chains::sealevel::adapter::SealevelAdapter;

    std::sync::Arc::new(SealevelAdapter::new_internal_with_block_time(
        estimated_block_time,
        client,
        provider,
        oracle,
        submitter,
    ))
}
