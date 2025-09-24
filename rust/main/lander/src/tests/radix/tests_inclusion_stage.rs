use std::{collections::HashMap, sync::Arc, time::Duration};

use core_api_client::models::FeeSummary;
use ethers::utils::hex;
use hyperlane_core::{identifiers::UniqueIdentifier, HyperlaneDomain, KnownHyperlaneDomain};
use hyperlane_radix::RadixSigner;
use tokio::sync::mpsc;
use tracing_test::traced_test;

use crate::{
    adapter::{
        chains::radix::{adapter::RadixAdapter, tests::MockRadixProvider, Precursor},
        RadixTxPrecursor,
    },
    dispatcher::{DispatcherState, InclusionStage, TransactionDb},
    tests::test_utils::tmp_dbs,
    transaction::{Transaction, VmSpecificTxData},
    DispatcherMetrics, FullPayload, PayloadStatus, TransactionStatus,
};

const TEST_BLOCK_TIME: Duration = Duration::from_nanos(0);
const TEST_DOMAIN: KnownHyperlaneDomain = KnownHyperlaneDomain::Radix;

const PRIVATE_KEY: &str = "E99BC4A79BCE79A990322FBE97E2CEFF85C5DB7B39C495215B6E2C7020FD103D";

const MAILBOX_ADDRESS: &str =
    "component_rdx1cpcq2wcs8zmpjanjf5ek76y4wttdxswnyfcuhynz4zmhjfjxqfsg9z";

#[derive(Clone, Debug)]
struct ExpectedRadixTxState {
    pub status: TransactionStatus,
    pub retries: u32,
    pub component_address: String,
    pub method: String,
}

fn mocked_radix_provider() -> MockRadixProvider {
    let mock_provider = MockRadixProvider::new();
    mock_provider
}

fn mocked_signer() -> RadixSigner {
    let priv_key_vec = hex::decode(PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");
    signer
}

fn mock_radix_adapter(provider: MockRadixProvider, signer: RadixSigner) -> RadixAdapter {
    let provider = Arc::new(provider);

    let private_key = signer.get_signer().expect("Failed to get private key");
    RadixAdapter {
        provider,
        signer,
        private_key,
        estimated_block_time: Duration::from_nanos(0),
    }
}
pub fn mock_dispatcher_state_with_provider(
    provider: MockRadixProvider,
    signer: RadixSigner,
) -> DispatcherState {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let adapter = mock_radix_adapter(provider, signer);
    DispatcherState::new(
        payload_db,
        tx_db,
        Arc::new(adapter),
        DispatcherMetrics::dummy_instance(),
        "test".to_string(),
    )
}

struct DummyRadixTxParams {
    pub payloads: Vec<FullPayload>,
    pub status: TransactionStatus,
    pub component_address: String,
    pub method_name: String,
    pub encoded_arguments: Vec<u8>,
    pub fee_summary: FeeSummary,
}
fn dummy_radix_tx(params: DummyRadixTxParams) -> Transaction {
    let DummyRadixTxParams {
        payloads,
        status,
        component_address,
        method_name,
        encoded_arguments,
        fee_summary,
    } = params;

    let details: Vec<_> = payloads
        .clone()
        .into_iter()
        .map(|payload| payload.details)
        .collect();
    Transaction {
        uuid: UniqueIdentifier::random(),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Radix(RadixTxPrecursor {
            component_address,
            method_name,
            encoded_arguments,
            fee_summary,
            tx_hash: None,
        }),
        payload_details: details.clone(),
        status,
        submission_attempts: 0,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
        last_status_check: None,
    }
}

async fn run_and_expect_successful_inclusion(
    expected_tx_states: Vec<ExpectedRadixTxState>,
    mock_provider: MockRadixProvider,
    signer: RadixSigner,
) {
    let (finality_stage_sender, _finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, signer);
    let mock_domain = TEST_DOMAIN.into();

    let created_tx = {
        let mut payload = FullPayload::random();
        payload.status = PayloadStatus::InTransaction(TransactionStatus::PendingInclusion);
        dispatcher_state
            .payload_db
            .store_payload_by_uuid(&payload)
            .await
            .unwrap();

        let tx = dummy_radix_tx(DummyRadixTxParams {
            payloads: vec![payload],
            status: TransactionStatus::PendingInclusion,
            component_address: MAILBOX_ADDRESS.into(),
            method_name: "process".into(),
            encoded_arguments: vec![],
            fee_summary: FeeSummary {
                execution_cost_units_consumed: 1200,
                finalization_cost_units_consumed: 1300,
                xrd_total_execution_cost: "1400".into(),
                xrd_total_finalization_cost: "1500".into(),
                xrd_total_royalty_cost: "1600".into(),
                xrd_total_storage_cost: "1700".into(),
                xrd_total_tipping_cost: "1800".into(),
            },
        });
        dispatcher_state
            .tx_db
            .store_transaction_by_uuid(&tx)
            .await
            .unwrap();
        tx
    };

    for expected_tx_state in expected_tx_states.iter() {
        InclusionStage::process_txs_step(
            &inclusion_stage_pool,
            &finality_stage_sender,
            &dispatcher_state,
            mock_domain,
        )
        .await
        .unwrap();
        assert_tx_db_state(expected_tx_state, &dispatcher_state.tx_db, &created_tx).await;
    }
}

async fn assert_tx_db_state(
    expected: &ExpectedRadixTxState,
    tx_db: &Arc<dyn TransactionDb>,
    created_tx: &Transaction,
) {
    let retrieved_tx = tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();

    eprintln!("{:?}", retrieved_tx);
    let radix_precursor = &retrieved_tx.precursor();

    assert_eq!(
        retrieved_tx.status, expected.status,
        "Transaction status mismatch"
    );
    assert_eq!(
        retrieved_tx.payload_details, created_tx.payload_details,
        "Payload details mismatch"
    );
    assert_eq!(
        retrieved_tx.submission_attempts, expected.retries,
        "Submission attempts mismatch"
    );
}

#[tokio::test]
#[traced_test]
async fn test_radix_inclusion_happy_path() {
    let block_time = TEST_BLOCK_TIME;
    let signer = mocked_signer();
    let mock_provider = mocked_radix_provider();

    let expected_tx_states = vec![
        ExpectedRadixTxState {
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            component_address: MAILBOX_ADDRESS.into(),
            method: "process".into(),
        },
        ExpectedRadixTxState {
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            component_address: MAILBOX_ADDRESS.into(),
            method: "process".into(),
        },
    ];
    run_and_expect_successful_inclusion(expected_tx_states, mock_provider, signer).await;
}
