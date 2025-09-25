use std::sync::Arc;

use core_api_client::models::{FeeSummary, StateUpdates, TransactionReceipt};
use ethers::utils::hex;
use eyre::Result;

use gateway_api_client::models::GatewayStatusResponse;
use hyperlane_core::{Encode, HyperlaneMessage};
use hyperlane_radix::{RadixSigner, RadixTxCalldata};
use hyperlane_sealevel::SealevelTxCostEstimate;
use radix_common::manifest_args;
use scrypto::prelude::{manifest_encode, ManifestArgs};
use uuid::Uuid;

use crate::adapter::chains::radix::adapter::tests::tests_common::{
    payload, MockRadixProvider, MAILBOX_ADDRESS, TEST_PRIVATE_KEY,
};
use crate::adapter::chains::radix::adapter::NODE_DEPTH;
use crate::adapter::chains::radix::precursor::RadixTxPrecursor;
use crate::adapter::{AdaptsChain, TxBuildingResult};
use crate::payload::PayloadDetails;
use crate::transaction::{Transaction, TransactionUuid, VmSpecificTxData};
use crate::{FullPayload, TransactionStatus};

use super::tests_common::adapter;

const MAILBOX_METHOD_NAME_RPOCESS: &str = "process";

#[tracing_test::traced_test]
#[tokio::test]
async fn test_simulate_tx() {
    // given
    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let mut provider = MockRadixProvider::new();
    provider.expect_get_gateway_status().returning(|| {
        Ok(GatewayStatusResponse {
            ..Default::default()
        })
    });
    let mut counter = 0;
    provider.expect_preview_tx().returning(move |_ops| {
        counter += 1;
        let status = if counter < 5 {
            core_api_client::models::TransactionStatus::Failed
        } else {
            core_api_client::models::TransactionStatus::Succeeded
        };
        Ok(TransactionReceipt {
            status,
            ..Default::default()
        })
    });

    let provider_arc = Arc::new(provider);
    let adapter = adapter(provider_arc.clone(), signer.clone());

    let message = HyperlaneMessage {
        origin: 1000,
        destination: 2000,
        ..Default::default()
    };
    let metadata: Vec<u8> = vec![1, 2, 3, 4];
    let args: ManifestArgs = manifest_args!(&metadata, &message.to_vec());
    let encoded_arguments = manifest_encode(&args).expect("Failed to encode manifest");

    let data = VmSpecificTxData::Radix(Box::new(RadixTxPrecursor::new(
        MAILBOX_ADDRESS.into(),
        MAILBOX_METHOD_NAME_RPOCESS.into(),
        encoded_arguments.clone(),
    )));

    let process_calldata = RadixTxCalldata {
        component_address: MAILBOX_ADDRESS.into(),
        method_name: MAILBOX_METHOD_NAME_RPOCESS.into(),
        encoded_arguments,
    };

    let process_calldata_vec =
        serde_json::to_vec(&process_calldata).expect("Failed to serialize to json");
    let payload = payload(process_calldata_vec);

    let mut transaction = Transaction {
        uuid: TransactionUuid::new(Uuid::new_v4()),
        tx_hashes: vec![],
        vm_specific_data: data,
        payload_details: vec![payload.details.clone()],
        status: TransactionStatus::PendingInclusion,
        submission_attempts: 0,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
        last_status_check: None,
    };

    // when
    let simulated = adapter
        .simulate_tx(&mut transaction)
        .await
        .expect("Failed to simulate tx");

    // then
    assert!(simulated.is_empty());
}
