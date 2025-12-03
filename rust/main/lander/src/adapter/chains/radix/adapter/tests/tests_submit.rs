use std::str::FromStr;
use std::sync::Arc;

use core_api_client::models::{FeeSummary, StateUpdates, TransactionReceipt};
use ethers::utils::hex;
use eyre::Result;
use gateway_api_client::models::{GatewayStatusResponse, LedgerState, TransactionSubmitResponse};
use radix_common::manifest_args;
use radix_transactions::model::{IntentHeaderV2, TransactionHeaderV2, TransactionPayload};
use radix_transactions::prelude::{
    DetailedNotarizedTransactionV2, ManifestBuilder, TransactionBuilder,
    TransactionManifestV2Builder, TransactionV2Builder,
};
use radix_transactions::signing::PrivateKey;
use scrypto::address::AddressBech32Decoder;
use scrypto::math::Decimal;
use scrypto::network::NetworkDefinition;
use scrypto::prelude::{manifest_encode, ManifestArgs};
use scrypto::types::{ComponentAddress, Epoch};
use uuid::Uuid;

use hyperlane_core::{ChainResult, Encode, HyperlaneMessage, H512};
use hyperlane_radix::{HyperlaneRadixError, RadixProvider, RadixSigner, RadixTxCalldata};

use crate::adapter::{AdaptsChain, TxBuildingResult};
use crate::payload::PayloadDetails;
use crate::transaction::{Transaction, TransactionUuid, VmSpecificTxData};
use crate::{FullPayload, TransactionStatus};

use super::super::super::adapter::NODE_DEPTH;
use super::super::super::precursor::RadixTxPrecursor;
use super::super::super::transaction::Precursor;
use super::super::super::VisibleComponents;
use super::tests_common::{adapter, payload, MockRadixProvider, MAILBOX_ADDRESS, TEST_PRIVATE_KEY};

const MAILBOX_METHOD_NAME_RPOCESS: &str = "process";

const ADDRESSES: &[&str] = &[
    "component_rdx1cznxpn5m3kutzr6jrhgnvv0x7uhcs0rf8fl2w59hkclm6m7axzlqgu",
    "component_rdx1crzkj7lujcdazgc4hpuvzlkmaddwnzh6d39ln5hrpxk6wllehqcdcf",
    "component_rdx1cz4c0upfeezhr7nxft5x3dg7w4gmhddy62d5a730lurazwkk830r4g",
];

#[tracing_test::traced_test]
#[tokio::test]
async fn test_radix_submit_tx() {
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

    let uuid = Uuid::from_u64_pair(0, 1);
    let mut transaction = Transaction {
        uuid: TransactionUuid::new(uuid),
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
    let hash_hex = hex::decode("0000000000000000000000000000000000000000000000000000000000000000d159515cb03bee92fb233a155c69bbc37588a70915e6a0965c411974b509b978")
        .expect("Failed to decode hex");
    let expected_hash = H512::from_slice(&hash_hex);
    assert_eq!(transaction.tx_hashes, vec![expected_hash]);

    let precursor = transaction.precursor();
    assert_eq!(precursor.tx_hash, Some(expected_hash));
}

#[ignore]
#[tracing_test::traced_test]
#[tokio::test]
async fn test_radix_lander_classic_build_transaction() {
    // given
    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let epoch = 124;
    let mut provider = MockRadixProvider::new();
    provider.expect_get_gateway_status().returning(|| {
        Ok(GatewayStatusResponse {
            ledger_state: LedgerState {
                epoch: 124,
                ..Default::default()
            },
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

    precursor.fee_summary = Some(fee_summary.clone());
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

    let transaction = Transaction {
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

    let intent_discriminator = 0u64;

    // when
    let lander_tx = adapter
        .build_transaction(&transaction, intent_discriminator)
        .await
        .expect("Failed to submit tx");

    let decoder = AddressBech32Decoder::new(&network);

    let mailbox_address = ComponentAddress::try_from_bech32(&decoder, MAILBOX_ADDRESS).unwrap();
    let visible_components: Vec<ComponentAddress> = ADDRESSES
        .iter()
        .map(|s| ComponentAddress::try_from_bech32(&decoder, s).unwrap())
        .collect();

    let message_bytes = message.to_vec();
    let metadata_bytes = metadata.to_vec();

    let classic_tx = RadixProvider::build_tx(
        &signer,
        &network,
        epoch,
        intent_discriminator,
        |builder| {
            builder.call_method(
                mailbox_address,
                "process",
                manifest_args!(&metadata_bytes, &message_bytes, &visible_components),
            )
        },
        fee_summary,
    )
    .expect("Failed to build tx");

    // then
    assert_eq!(lander_tx, classic_tx);
}
