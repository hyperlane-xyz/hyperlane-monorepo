use std::str::FromStr;
use std::sync::Arc;

use core_api_client::models::{FeeSummary, TransactionReceipt};
use ethers::utils::hex;
use gateway_api_client::models::GatewayStatusResponse;
use radix_common::manifest_args;
use scrypto::network::NetworkDefinition;
use scrypto::prelude::{manifest_encode, ManifestArgs};

use hyperlane_core::{Encode, FixedPointNumber, HyperlaneMessage};
use hyperlane_radix::{RadixProvider, RadixSigner, RadixTxCalldata};

use crate::adapter::AdaptsChain;

use super::tests_common::{adapter, payload, MockRadixProvider, MAILBOX_ADDRESS, TEST_PRIVATE_KEY};

const MAILBOX_METHOD_NAME_PROCESS: &str = "process";

#[tokio::test]
async fn test_estimate_gas_limit() {
    let mut provider = MockRadixProvider::new();
    provider.expect_get_gateway_status().returning(|| {
        Ok(GatewayStatusResponse {
            ..Default::default()
        })
    });

    let fee_summary = FeeSummary::new(
        1_000,
        2_000,
        "3000".into(),
        "4000".into(),
        "5000".into(),
        "6000".into(),
        "7000".into(),
    );
    let fee_summary_clone = fee_summary.clone();
    provider.expect_preview_tx().returning(move |_| {
        Ok(TransactionReceipt {
            status: core_api_client::models::TransactionStatus::Succeeded,
            fee_summary: fee_summary_clone.clone(),
            ..Default::default()
        })
    });

    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let provider_arc = Arc::new(provider);
    let network = NetworkDefinition::mainnet();
    let adapter = adapter(&network, provider_arc, signer);

    let message = HyperlaneMessage {
        origin: 1000,
        destination: 2000,
        ..Default::default()
    };
    let metadata: Vec<u8> = vec![1, 2, 3, 4];
    let args: ManifestArgs = manifest_args!(&metadata, &message.to_vec());
    let encoded_arguments = manifest_encode(&args).expect("Failed to encode manifest");

    let process_calldata = RadixTxCalldata {
        component_address: MAILBOX_ADDRESS.into(),
        method_name: MAILBOX_METHOD_NAME_PROCESS.into(),
        encoded_arguments,
    };
    let payload = payload(serde_json::to_vec(&process_calldata).expect("serialize calldata"));

    let estimate = adapter.estimate_gas_limit(&payload).await.unwrap();

    let expected_gas_limit =
        fee_summary.execution_cost_units_consumed + fee_summary.finalization_cost_units_consumed;
    let paid = RadixProvider::total_fee(fee_summary).unwrap();
    let paid_per_unit = paid / expected_gas_limit;
    let expected_gas_price = FixedPointNumber::from_str(&paid_per_unit.to_string()).unwrap();

    assert_eq!(estimate.gas_limit, expected_gas_limit.into());
    assert_eq!(estimate.gas_price, expected_gas_price);
    assert_eq!(estimate.l2_gas_limit, None);
}

#[tokio::test]
async fn test_estimate_gas_limit_for_preparation_matches_estimate_gas_limit() {
    let mut provider = MockRadixProvider::new();
    provider.expect_get_gateway_status().times(2).returning(|| {
        Ok(GatewayStatusResponse {
            ..Default::default()
        })
    });

    let fee_summary = FeeSummary::new(
        1_000,
        2_000,
        "3000".into(),
        "4000".into(),
        "5000".into(),
        "6000".into(),
        "7000".into(),
    );
    let fee_summary_clone = fee_summary.clone();
    provider.expect_preview_tx().times(2).returning(move |_| {
        Ok(TransactionReceipt {
            status: core_api_client::models::TransactionStatus::Succeeded,
            fee_summary: fee_summary_clone.clone(),
            ..Default::default()
        })
    });

    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let provider_arc = Arc::new(provider);
    let network = NetworkDefinition::mainnet();
    let adapter = adapter(&network, provider_arc, signer);

    let message = HyperlaneMessage {
        origin: 1000,
        destination: 2000,
        ..Default::default()
    };
    let metadata: Vec<u8> = vec![1, 2, 3, 4];
    let args: ManifestArgs = manifest_args!(&metadata, &message.to_vec());
    let encoded_arguments = manifest_encode(&args).expect("Failed to encode manifest");

    let process_calldata = RadixTxCalldata {
        component_address: MAILBOX_ADDRESS.into(),
        method_name: MAILBOX_METHOD_NAME_PROCESS.into(),
        encoded_arguments,
    };
    let payload = payload(serde_json::to_vec(&process_calldata).expect("serialize calldata"));

    let estimate = adapter.estimate_gas_limit(&payload).await.unwrap();
    let preparation_estimate = adapter
        .estimate_gas_limit_for_preparation(&payload)
        .await
        .unwrap();

    assert_eq!(preparation_estimate, estimate);
}
