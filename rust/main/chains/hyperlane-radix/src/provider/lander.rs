use gateway_api_client::models::{TransactionStatusResponse, TransactionSubmitResponse};
use hyperlane_core::{ChainResult, H512};

use crate::{RadixDeliveredCalldata, RadixGatewayProvider, RadixProvider};

/// Trait used by lander
#[async_trait::async_trait]
pub trait RadixProviderForLander: Send + Sync {
    /// Get the status of a radix transaction
    async fn get_tx_hash_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse>;
    /// Check preview call
    async fn check_preview(&self, params: &RadixDeliveredCalldata) -> ChainResult<bool>;
    /// Send transaction to network
    async fn send_transaction(&self, tx: Vec<u8>) -> ChainResult<TransactionSubmitResponse>;
}

#[async_trait::async_trait]
impl RadixProviderForLander for RadixProvider {
    async fn get_tx_hash_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse> {
        self.get_tx_status(hash).await
    }
    async fn check_preview(&self, params: &RadixDeliveredCalldata) -> ChainResult<bool> {
        let resp = self
            .call_method::<bool>(
                &params.component_address,
                &params.method_name,
                None,
                vec![params.encoded_arguments.clone()],
            )
            .await?;
        Ok(resp.0)
    }
    async fn send_transaction(&self, tx: Vec<u8>) -> ChainResult<TransactionSubmitResponse> {
        self.submit_transaction(tx).await
    }
}
