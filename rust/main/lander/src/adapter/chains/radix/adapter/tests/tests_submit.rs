use std::sync::Arc;

use core_api_client::models::{FeeSummary, StateUpdates, TransactionReceipt};
use ethers::utils::hex;
use eyre::Result;

use gateway_api_client::models::{GatewayStatusResponse, TransactionSubmitResponse};
use hyperlane_core::{Encode, HyperlaneMessage, H512};
use hyperlane_radix::{RadixSigner, RadixTxCalldata};
use hyperlane_sealevel::SealevelTxCostEstimate;
use radix_common::manifest_args;
use scrypto::address::AddressBech32Decoder;
use scrypto::network::NetworkDefinition;
use scrypto::prelude::{manifest_encode, ManifestArgs};
use scrypto::types::ComponentAddress;
use uuid::Uuid;

use crate::adapter::chains::radix::adapter::NODE_DEPTH;
use crate::adapter::chains::radix::precursor::RadixTxPrecursor;
use crate::adapter::chains::radix::{Precursor, VisibleComponents};
use crate::adapter::{AdaptsChain, TxBuildingResult};
use crate::payload::PayloadDetails;
use crate::transaction::{Transaction, TransactionUuid, VmSpecificTxData};
use crate::{FullPayload, TransactionStatus};

use super::tests_common::{adapter, payload, MockRadixProvider, MAILBOX_ADDRESS, TEST_PRIVATE_KEY};

const MAILBOX_METHOD_NAME_RPOCESS: &str = "process";

const ADDRESSES: &[&str] = &[
    "component_rdx1cznxpn5m3kutzr6jrhgnvv0x7uhcs0rf8fl2w59hkclm6m7axzlqgu",
    "component_rdx1crzkj7lujcdazgc4hpuvzlkmaddwnzh6d39ln5hrpxk6wllehqcdcf",
    "component_rdx1cz4c0upfeezhr7nxft5x3dg7w4gmhddy62d5a730lurazwkk830r4g",
];

#[tracing_test::traced_test]
#[tokio::test]
async fn test_submit_tx() {
    // given
    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let mut provider = MockRadixProvider::new();
    provider.expect_get_gateway_status().returning(|| {
        Ok(GatewayStatusResponse {
            ..Default::default()
        })
    });
    provider
        .expect_send_transaction()
        .returning(|_| Ok(TransactionSubmitResponse::new(false)));

    let mut counter = 0;
    provider.expect_preview_tx().returning(move |_ops| {
        counter += 1;
        if counter <= ADDRESSES.len() {
            Ok(TransactionReceipt {
                status: core_api_client::models::TransactionStatus::Failed,
                error_message: Some(ADDRESSES[counter - 1].to_string()),
                ..Default::default()
            })
        } else {
            Ok(TransactionReceipt {
                status: core_api_client::models::TransactionStatus::Succeeded,
                ..Default::default()
            })
        }
    });

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

    let visible_components: Vec<_> = ADDRESSES.iter().map(|s| s.to_string()).collect();

    let mut precursor = RadixTxPrecursor::new(
        MAILBOX_ADDRESS.into(),
        MAILBOX_METHOD_NAME_RPOCESS.into(),
        encoded_arguments.clone(),
    );
    let fee_summary = FeeSummary::new(
        1000,
        2000,
        "3000".into(),
        "4000".into(),
        "5000".into(),
        "6000".into(),
        "7000".into(),
    );

    precursor.fee_summary = Some(fee_summary);
    precursor.visible_components = Some(VisibleComponents {
        addresses: visible_components,
    });
    let data = VmSpecificTxData::Radix(Box::new(precursor));

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
    adapter
        .submit(&mut transaction)
        .await
        .expect("Failed to submit tx");

    // then
    let hash_hex = hex::decode("0000000000000000000000000000000000000000000000000000000000000000e038f6e0809d9c11366dbc7a10354ff0304f4ec081c92cf1fea01575cf282247")
        .expect("Failed to decode hex");
    let expected_hash = H512::from_slice(&hash_hex);
    assert_eq!(transaction.tx_hashes, vec![expected_hash]);

    let precursor = transaction.precursor();
    assert_eq!(precursor.tx_hash, Some(expected_hash));
}
