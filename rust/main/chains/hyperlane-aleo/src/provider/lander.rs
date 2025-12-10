use async_trait::async_trait;

use hyperlane_core::{ChainResult, H512};

use crate::provider::{AleoClient, AleoProvider};

/// Trait defining the interface that Lander's AleoAdapter needs from an Aleo provider.
/// This allows for mocking in tests while using the real AleoProvider in production.
#[async_trait]
pub trait AleoProviderForLander: Send + Sync {
    /// Submits a transaction and returns the transaction hash
    ///
    /// # Arguments
    /// * `program_id` - The program to execute
    /// * `function_name` - The function to call
    /// * `input` - Input parameters
    ///
    /// # Returns
    /// * `Ok(transaction_hash)` - Transaction hash
    /// * `Err(...)` - Submission failed
    async fn submit_tx<I>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = String> + Send,
        I::IntoIter: ExactSizeIterator;
}

#[async_trait]
impl<C: AleoClient> AleoProviderForLander for AleoProvider<C> {
    async fn submit_tx<I>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = String> + Send,
        I::IntoIter: ExactSizeIterator,
    {
        self.submit_tx(program_id, function_name, input).await
    }
}
