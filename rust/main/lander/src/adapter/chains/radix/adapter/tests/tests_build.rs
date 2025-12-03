use std::sync::Arc;

use ethers::utils::hex;
use eyre::Result;
use radix_common::manifest_args;
use scrypto::network::NetworkDefinition;
use scrypto::prelude::{manifest_encode, ManifestArgs};

use hyperlane_core::{Encode, HyperlaneMessage};
use hyperlane_radix::{RadixSigner, RadixTxCalldata};

use crate::adapter::{AdaptsChain, TxBuildingResult};
use crate::payload::PayloadDetails;
use crate::transaction::VmSpecificTxData;
use crate::FullPayload;

use super::super::super::precursor::RadixTxPrecursor;

use super::tests_common::{adapter, payload, MockRadixProvider, MAILBOX_ADDRESS, TEST_PRIVATE_KEY};

const MAILBOX_METHOD_NAME_RPOCESS: &str = "process";

#[tokio::test]
async fn test_build_transactions() {
    // given
    let provider = MockRadixProvider::new();
    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let provider_arc = Arc::new(provider);
    let network = NetworkDefinition::mainnet();
    let adapter = adapter(&network, provider_arc.clone(), signer.clone());

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

    let expected = (payload.details.clone(), data);

    // when
    let result = adapter.build_transactions(&[payload.clone()]).await;

    // then
    let actual = payload_details_and_data_in_transaction(result);
    assert_eq!(expected, actual);
}

#[tokio::test]
async fn test_build_transactions_failed() {
    // given
    let provider = MockRadixProvider::new();
    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let provider_arc = Arc::new(provider);
    let network = NetworkDefinition::mainnet();
    let adapter = adapter(&network, provider_arc.clone(), signer.clone());

    // invalid json
    let payload = payload(vec![1, 2, 3, 4]);

    // when
    let result = adapter.build_transactions(&[payload.clone()]).await;

    // then
    let expected = vec![TxBuildingResult {
        payloads: vec![payload.details.clone()],
        maybe_tx: None,
    }];
    assert_eq!(result, expected);
}

fn payload_details_and_data_in_transaction(
    transactions: Vec<TxBuildingResult>,
) -> (PayloadDetails, VmSpecificTxData) {
    let transaction = transactions.first().expect("No tx found");
    (
        transaction
            .payloads
            .first()
            .expect("Payload not found")
            .clone(),
        transaction
            .maybe_tx
            .clone()
            .expect("maybe_tx not found")
            .vm_specific_data
            .clone(),
    )
}
