use async_trait::async_trait;

use hyperlane_core::{ChainResult, H512};

use crate::{
    provider::{AleoClient, AleoProvider},
    FeeEstimate,
};

/// Trait defining the interface that Lander's AleoAdapter needs from an Aleo provider.
/// This allows for mocking in tests while using the real AleoProvider in production.
#[async_trait]
pub trait AleoProviderForLander: Send + Sync {
    /// Submits a transaction with an optional pre-computed fee estimate
    ///
    /// # Arguments
    /// * `program_id` - The program to execute
    /// * `function_name` - The function to call
    /// * `input` - Input parameters
    /// * `fee_estimate` - Optional cached fee. If None, fee will be estimated internally.
    ///
    /// # Returns
    /// * `Ok((transaction_hash, fee_used))` - Transaction hash and the fee that was used
    /// * `Err(...)` - Submission or estimation failed
    async fn submit_tx_with_fee<I>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
        fee_estimate: Option<FeeEstimate>,
    ) -> ChainResult<(H512, FeeEstimate)>
    where
        I: IntoIterator<Item = String> + Send,
        I::IntoIter: ExactSizeIterator;
}

#[async_trait]
impl<C: AleoClient> AleoProviderForLander for AleoProvider<C> {
    async fn submit_tx_with_fee<I>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
        fee_estimate: Option<FeeEstimate>,
    ) -> ChainResult<(H512, FeeEstimate)>
    where
        I: IntoIterator<Item = String> + Send,
        I::IntoIter: ExactSizeIterator,
    {
        self.submit_tx_with_fee(program_id, function_name, input, fee_estimate)
            .await
    }
}
