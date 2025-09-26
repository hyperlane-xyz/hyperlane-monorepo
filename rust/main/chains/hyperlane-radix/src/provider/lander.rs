use core_api_client::models::TransactionReceipt;
use gateway_api_client::models::{
    GatewayStatusResponse, TransactionPreviewV2Request, TransactionStatusResponse,
    TransactionSubmitResponse,
};

use hyperlane_core::{ChainCommunicationError, ChainResult, H512};

use crate::{RadixGatewayProvider, RadixProvider, RadixTxCalldata};

/// Trait used by lander
#[async_trait::async_trait]
pub trait RadixProviderForLander: Send + Sync {
    /// Get gateway status
    async fn get_gateway_status(&self) -> ChainResult<GatewayStatusResponse>;
    /// Get the status of a radix transaction
    async fn get_tx_hash_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse>;
    /// Check preview call
    async fn check_preview(&self, params: &RadixTxCalldata) -> ChainResult<bool>;
    /// Send transaction to network
    async fn send_transaction(&self, tx: Vec<u8>) -> ChainResult<TransactionSubmitResponse>;
    /// Preview a transaction
    async fn preview_tx(&self, req: TransactionPreviewV2Request)
        -> ChainResult<TransactionReceipt>;
}

#[async_trait::async_trait]
impl RadixProviderForLander for RadixProvider {
    async fn get_gateway_status(&self) -> ChainResult<GatewayStatusResponse> {
        self.gateway_status().await
    }
    async fn get_tx_hash_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse> {
        self.get_tx_status(hash).await
    }
    async fn check_preview(&self, params: &RadixTxCalldata) -> ChainResult<bool> {
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
    async fn preview_tx(
        &self,
        req: TransactionPreviewV2Request,
    ) -> ChainResult<TransactionReceipt> {
        let response = self.transaction_preview(req).await?;

        let Some(receipt) = response.receipt else {
            return Err(ChainCommunicationError::InvalidRequest {
                msg: "Transaction receipt missing".into(),
            });
        };
        let receipt: TransactionReceipt =
            serde_json::from_value(receipt).map_err(ChainCommunicationError::from)?;
        Ok(receipt)
    }
}
