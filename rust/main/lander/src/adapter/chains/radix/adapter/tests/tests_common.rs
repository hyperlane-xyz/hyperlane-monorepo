use std::{sync::Arc, time::Duration};

use core_api_client::models::TransactionReceipt;
use gateway_api_client::models::{
    GatewayStatusResponse, TransactionPreviewV2Request, TransactionStatusResponse,
    TransactionSubmitResponse,
};
use scrypto::network::NetworkDefinition;

use hyperlane_core::{ChainResult, H512, U256};
use hyperlane_radix::{RadixProviderForLander, RadixSigner, RadixTxCalldata};

use crate::{transaction::VmSpecificTxData, FullPayload};

use super::super::super::adapter::RadixAdapter;

// random private key used for testing
pub const TEST_PRIVATE_KEY: &str =
    "E99BC4A79BCE79A990322FBE97E2CEFF85C5DB7B39C495215B6E2C7020FD103D";
pub const MAILBOX_ADDRESS: &str =
    "component_rdx1cpcq2wcs8zmpjanjf5ek76y4wttdxswnyfcuhynz4zmhjfjxqfsg9z";

mockall::mock! {
    pub RadixProvider {}

    #[async_trait::async_trait]
    impl RadixProviderForLander for RadixProvider {
        async fn get_gateway_status(&self) -> ChainResult<GatewayStatusResponse>;
        async fn get_tx_hash_status(&self, hash: H512) -> ChainResult<TransactionStatusResponse>;
        async fn check_preview(&self, params: &RadixTxCalldata) -> ChainResult<bool>;
        async fn send_transaction(&self, tx: Vec<u8>) -> ChainResult<TransactionSubmitResponse>;
        async fn preview_tx(&self, req: TransactionPreviewV2Request)
            -> ChainResult<TransactionReceipt>;
    }
}

pub fn adapter(
    network: &NetworkDefinition,
    provider: Arc<MockRadixProvider>,
    signer: RadixSigner,
) -> RadixAdapter {
    let component_regex = regex::Regex::new(&format!(r"\w+_{}([a-zA-Z0-9]+)", network.hrp_suffix))
        .expect("Invalid regex");
    RadixAdapter {
        provider,
        network: network.clone(),
        signer,
        estimated_block_time: Duration::from_nanos(0),
        component_regex,
    }
}

pub fn payload(process_calldata: Vec<u8>) -> FullPayload {
    FullPayload {
        data: process_calldata,
        ..Default::default()
    }
}
