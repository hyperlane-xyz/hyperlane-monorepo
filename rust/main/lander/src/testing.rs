//! Integration test utilities and factory functions
//!
//! This module contains helper functions for creating test instances of dispatchers
//! and adapters in integration tests. These functions are only available when the
//! `integration_test` feature is enabled.

use std::sync::Arc;

use crate::adapter::AdaptsChain;
use crate::dispatcher::DispatcherState;
use crate::{Dispatcher, DispatcherEntrypoint, DispatcherMetrics, PayloadDb, TransactionDb};

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
pub async fn create_test_dispatcher(
    adapter: Arc<dyn AdaptsChain>,
    payload_db: Arc<dyn PayloadDb>,
    tx_db: Arc<dyn TransactionDb>,
    domain: String,
) -> (DispatcherEntrypoint, Dispatcher) {
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
pub fn create_test_sealevel_adapter(
    client: Arc<dyn hyperlane_sealevel::fallback::SubmitSealevelRpc>,
    provider: Arc<dyn hyperlane_sealevel::SealevelProviderForLander>,
    oracle: Arc<dyn hyperlane_sealevel::PriorityFeeOracle>,
    submitter: Arc<dyn hyperlane_sealevel::TransactionSubmitter>,
    estimated_block_time: std::time::Duration,
) -> Arc<dyn AdaptsChain> {
    use crate::adapter::chains::sealevel::adapter::SealevelAdapter;

    Arc::new(SealevelAdapter::new_internal_with_block_time(
        estimated_block_time,
        client,
        provider,
        oracle,
        submitter,
    ))
}
