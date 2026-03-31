use async_trait::async_trait;

use hyperlane_aleo::{
    AleoConfirmedTransaction, AleoProviderForLander, AleoUnconfirmedTransaction, CurrentNetwork,
    Plaintext,
};
use hyperlane_core::{ChainResult, H512};

/// Mock Aleo provider for testing
///
/// Returns random transaction hashes for all submissions.
/// Note: We use a manual implementation instead of mockall because the trait has
/// generic methods with complex trait bounds that mockall cannot handle well.
pub struct MockAleoProvider;

#[async_trait]
impl AleoProviderForLander for MockAleoProvider {
    async fn submit_tx<I>(
        &self,
        _program_id: &str,
        _function_name: &str,
        _input: I,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = String> + Send,
        I::IntoIter: ExactSizeIterator,
    {
        Ok(H512::random())
    }

    async fn request_confirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoConfirmedTransaction<CurrentNetwork>> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "Mock provider: get_confirmed_transaction not implemented",
        ))
    }

    async fn request_unconfirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoUnconfirmedTransaction<CurrentNetwork>> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "Mock provider: get_unconfirmed_transaction not implemented",
        ))
    }

    async fn mapping_value_exists(
        &self,
        _program_id: &str,
        _mapping_name: &str,
        _mapping_key: &Plaintext<CurrentNetwork>,
    ) -> ChainResult<bool> {
        // Default: mapping values don't exist (messages not delivered)
        Ok(false)
    }
}
