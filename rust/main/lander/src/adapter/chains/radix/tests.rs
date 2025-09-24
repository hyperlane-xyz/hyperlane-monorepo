use core_api_client::models::TransactionReceipt;
use gateway_api_client::models::{
    TransactionPreviewV2Request, TransactionStatusResponse, TransactionSubmitResponse,
};
use hyperlane_core::{ChainResult, H512};
use hyperlane_radix::{RadixProviderForLander, RadixTxCalldata};

mockall::mock! {
    pub RadixProvider {}

    #[async_trait::async_trait]
    impl RadixProviderForLander for RadixProvider {
        async fn get_tx_hash_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse>;
        async fn check_preview(&self, params: &RadixTxCalldata) -> ChainResult<bool>;
        async fn send_transaction(&self, tx: Vec<u8>) -> ChainResult<TransactionSubmitResponse>;
        async fn preview_tx(&self, req: TransactionPreviewV2Request) -> ChainResult<TransactionReceipt>;
    }
}

fn a() {}
