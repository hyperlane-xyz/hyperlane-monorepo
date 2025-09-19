use gateway_api_client::models::TransactionStatusResponse;
use hyperlane_core::{ChainResult, H512};

use crate::RadixProvider;

/// Trait used by lander
#[async_trait::async_trait]
pub trait RadixProviderForLander: Send + Sync {
    /// Get the status of a radix transaction
    async fn get_tx_hash_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse>;
}

#[async_trait::async_trait]
impl RadixProviderForLander for RadixProvider {
    async fn get_tx_hash_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse> {
        self.get_tx_status(hash).await
    }
}
