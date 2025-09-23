use gateway_api_client::models::{TransactionStatusResponse, TransactionSubmitResponse};
use hyperlane_core::{ChainResult, H512};
use hyperlane_radix::{RadixDeliveredCalldata, RadixProviderForLander};

mockall::mock! {
    pub RadixProvider {}

    #[async_trait::async_trait]
    impl RadixProviderForLander for RadixProvider {
        async fn get_tx_hash_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse>;
        async fn check_preview(&self, params: &RadixDeliveredCalldata) -> ChainResult<bool>;
        async fn send_transaction(&self, tx: Vec<u8>) -> ChainResult<TransactionSubmitResponse>;
    }
}

fn a() {}
