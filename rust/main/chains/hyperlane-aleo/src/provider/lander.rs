use async_trait::async_trait;
use snarkvm::{ledger::ConfirmedTransaction, prelude::Transaction};

use hyperlane_core::{ChainResult, H512};

use crate::{
    provider::{AleoClient, AleoProvider},
    CurrentNetwork,
};

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

    /// Gets the status of a confirmed transaction by its ID
    async fn get_confirmed_transaction(
        &self,
        transaction_id: H512,
    ) -> ChainResult<ConfirmedTransaction<CurrentNetwork>>;

    /// Gets an unconfirmed transaction from the mempool by its ID
    async fn get_unconfirmed_transaction(
        &self,
        transaction_id: H512,
    ) -> ChainResult<Transaction<CurrentNetwork>>;
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

    async fn get_confirmed_transaction(
        &self,
        transaction_id: H512,
    ) -> ChainResult<ConfirmedTransaction<CurrentNetwork>> {
        self.get_confirmed_transaction(transaction_id).await
    }

    async fn get_unconfirmed_transaction(
        &self,
        transaction_id: H512,
    ) -> ChainResult<Transaction<CurrentNetwork>> {
        self.get_unconfirmed_transaction(transaction_id).await
    }
}
