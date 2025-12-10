use async_trait::async_trait;

use hyperlane_aleo::AleoProviderForLander;
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
}
