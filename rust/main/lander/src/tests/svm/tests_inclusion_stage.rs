use std::{collections::HashMap, sync::Arc, time::Duration};

use hyperlane_core::KnownHyperlaneDomain;
use hyperlane_sealevel::{SealevelKeypair, SealevelTxCostEstimate, TransactionSubmitter};
use solana_client::rpc_response::RpcSimulateTransactionResult;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction, hash::Hash,
    instruction::Instruction as SealevelInstruction, message::Message, pubkey::Pubkey,
    signature::Signature, signer::Signer, system_instruction,
    transaction::Transaction as SealevelTransaction,
};
use tokio::{select, sync::mpsc};
use tracing_test::traced_test;

use crate::{
    adapter::{
        chains::sealevel::{
            adapter::tests::tests_common::{
                encoded_svm_transaction, svm_block, MockClient, MockOracle, MockSubmitter,
                MockSvmProvider,
            },
            transaction::{Precursor, TransactionFactory},
            SealevelAdapter,
        },
        SealevelTxPrecursor,
    },
    dispatcher::{DispatcherState, InclusionStage, PayloadDb, TransactionDb},
    tests::test_utils::tmp_dbs,
    transaction::Transaction,
    DispatcherMetrics, FullPayload, PayloadStatus, TransactionStatus,
};

const TEST_BLOCK_TIME: Duration = Duration::from_millis(50);
const TEST_DOMAIN: KnownHyperlaneDomain = KnownHyperlaneDomain::SolanaMainnet;

#[tokio::test]
#[traced_test]
async fn test_svm_inclusion_happy_path() {
    let block_time = TEST_BLOCK_TIME;

    let mut client = MockClient::new();
    mock_simulate_transaction(&mut client);
    mock_get_transaction_with_commitment(&mut client);
    mock_get_block_with_commitment(&mut client);
    let oracle = MockOracle::new();
    let mut provider = MockSvmProvider::new();
    mock_create_transaction_for_instruction(&mut provider);
    mock_get_estimated_costs_for_instruction(&mut provider);
    let mut submitter = MockSubmitter::new();
    mock_get_priority_fee_instruction(&mut submitter);
    mock_send_transaction(&mut submitter);
    mock_wait_for_transaction_confirmation(&mut submitter);
    mock_confirm_transaction(&mut submitter);
    let mock_svm_adapter = mocked_svm_adapter(block_time, client, oracle, provider, submitter);

    let expected_tx_states = vec![
        ExpectedSvmTxState {
            compute_units: 1400000,
            compute_unit_price_micro_lamports: 0,
            status: TransactionStatus::PendingInclusion,
            retries: 0,
        },
        ExpectedSvmTxState {
            compute_units: 1400000,
            compute_unit_price_micro_lamports: 0,
            status: TransactionStatus::Mempool,
            retries: 1,
        },
        ExpectedSvmTxState {
            compute_units: 1400000,
            compute_unit_price_micro_lamports: 0,
            // final status is `Finalized` because `get_transaction_with_commitment` returns an `Ok` response
            // regardless of the commitment level it's called with
            status: TransactionStatus::Finalized,
            retries: 1,
        },
    ];
    run_and_expect_successful_inclusion(expected_tx_states, mock_svm_adapter).await;
}

struct ExpectedSvmTxState {
    pub compute_units: u32,
    pub compute_unit_price_micro_lamports: u64,
    pub status: TransactionStatus,
    pub retries: u32,
}

async fn run_and_expect_successful_inclusion(
    mut expected_tx_states: Vec<ExpectedSvmTxState>,
    mock_svm_adapter: SealevelAdapter,
) {
    let dispatcher_state = mock_dispatcher_state_with_adapter(mock_svm_adapter);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_svm_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::PendingInclusion,
    )
    .await;

    let mock_domain = TEST_DOMAIN.into();
    inclusion_stage_pool
        .lock()
        .await
        .insert(created_tx.uuid.clone(), created_tx.clone());

    let expected_tx_state = expected_tx_states.remove(0);
    assert_tx_db_state(&expected_tx_state, &dispatcher_state.tx_db, &created_tx).await;

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

    // need to manually set this because panics don't propagate through the select! macro
    // the `select!` macro interferes with the lints, so need to manually `allow`` here
    #[allow(unused_assignments)]
    let mut success = false;
    select! {
        tx_received = finality_stage_receiver.recv() => {
            let tx_received = tx_received.unwrap();
            assert_eq!(tx_received.payload_details[0].uuid, created_tx.payload_details[0].uuid);
            success = true;
        },
        _ = tokio::time::sleep(Duration::from_millis(5000)) => {}
    }
    assert!(
        success,
        "Inclusion stage did not process the txs successfully"
    );
}

fn mocked_svm_adapter(
    block_time: Duration,
    client: MockClient,
    oracle: MockOracle,
    provider: MockSvmProvider,
    submitter: MockSubmitter,
) -> SealevelAdapter {
    SealevelAdapter::new_internal_with_block_time(
        block_time,
        Arc::new(client),
        Arc::new(provider),
        Arc::new(oracle),
        Arc::new(submitter),
    )
}

pub fn mock_dispatcher_state_with_adapter(adapter: SealevelAdapter) -> DispatcherState {
    let (payload_db, tx_db, _) = tmp_dbs();
    DispatcherState::new(
        payload_db,
        tx_db,
        Arc::new(adapter),
        DispatcherMetrics::dummy_instance(),
        "test".to_string(),
    )
}

async fn mock_svm_tx(
    payload_db: &Arc<dyn PayloadDb>,
    tx_db: &Arc<dyn TransactionDb>,
    status: TransactionStatus,
) -> Transaction {
    let mut payload = FullPayload::random();
    payload.status = PayloadStatus::InTransaction(status.clone());
    let data = serde_json::to_vec(&mock_svm_instruction()).unwrap();
    payload.data = data;
    payload_db.store_payload_by_uuid(&payload).await.unwrap();
    let precursor = SealevelTxPrecursor::from_payload(&payload);
    let tx = TransactionFactory::build(&payload, precursor);
    tx_db.store_transaction_by_uuid(&tx).await.unwrap();
    tx
}

fn mock_svm_instruction() -> SealevelInstruction {
    system_instruction::allocate(
        &Pubkey::new_unique(), // random pubkey
        10,
    )
}

fn mock_create_transaction_for_instruction(mock_provider: &mut MockSvmProvider) {
    mock_provider
        .expect_create_transaction_for_instruction()
        .returning(
            |compute_unit_limit: u32,
             compute_unit_price_micro_lamports: u64,
             instruction: SealevelInstruction,
             payer: &SealevelKeypair,
             tx_submitter: Arc<dyn TransactionSubmitter>,
             _sign: bool| {
                let instructions = vec![
                    // Set the compute unit limit.
                    ComputeBudgetInstruction::set_compute_unit_limit(compute_unit_limit),
                    // Set the priority fee / tip
                    tx_submitter.get_priority_fee_instruction(
                        compute_unit_price_micro_lamports,
                        compute_unit_limit.into(),
                        &payer.pubkey(),
                    ),
                    instruction,
                ];

                let recent_blockhash = Hash::new_unique();
                let tx = SealevelTransaction::new_unsigned(Message::new_with_blockhash(
                    &instructions,
                    Some(&payer.pubkey()),
                    &recent_blockhash,
                ));

                Ok(tx)
            },
        );
}

fn mock_get_estimated_costs_for_instruction(mock_provider: &mut MockSvmProvider) {
    mock_provider
        .expect_get_estimated_costs_for_instruction()
        .returning(
            |_instruction, _payer, _tx_submitter, _priority_fee_oracle| {
                Ok(SealevelTxCostEstimate::default())
            },
        );
}

fn mock_get_priority_fee_instruction(mock_provider: &mut MockSubmitter) {
    mock_provider
        .expect_get_priority_fee_instruction()
        .returning(
            |compute_unit_price_micro_lamports, _compute_units, _payer| {
                ComputeBudgetInstruction::set_compute_unit_price(compute_unit_price_micro_lamports)
            },
        );
}

fn mock_simulate_transaction(mock_provider: &mut MockClient) {
    mock_provider
        .expect_simulate_transaction()
        .returning(|_tx| {
            Ok(RpcSimulateTransactionResult {
                err: None,
                logs: None,
                accounts: None,
                units_consumed: None,
                return_data: None,
            })
        });
}

fn mock_send_transaction(mock_submitter: &mut MockSubmitter) {
    let signature = Signature::default();
    mock_submitter
        .expect_send_transaction()
        .returning(move |_, _| Ok(signature.clone()));
}

fn mock_wait_for_transaction_confirmation(mock_submitter: &mut MockSubmitter) {
    mock_submitter
        .expect_wait_for_transaction_confirmation()
        .returning(|_| Ok(()));
}

fn mock_confirm_transaction(mock_submitter: &mut MockSubmitter) {
    mock_submitter
        .expect_confirm_transaction()
        .returning(move |_, _| Ok(true));
}

fn mock_get_transaction_with_commitment(mock_provider: &mut MockClient) {
    mock_provider
        .expect_get_transaction_with_commitment()
        .returning(|_, _| Ok(encoded_svm_transaction()));
}

fn mock_get_block_with_commitment(mock_provider: &mut MockClient) {
    mock_provider
        .expect_get_block_with_commitment()
        .returning(|_, _| Ok(svm_block()));
}

async fn assert_tx_db_state(
    expected: &ExpectedSvmTxState,
    tx_db: &Arc<dyn TransactionDb>,
    created_tx: &Transaction,
) {
    let retrieved_tx = tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();
    let svm_tx = retrieved_tx.precursor();

    assert_eq!(
        svm_tx.estimate.compute_units, expected.compute_units,
        "Compute units do not match"
    );
    assert_eq!(
        svm_tx.estimate.compute_unit_price_micro_lamports,
        expected.compute_unit_price_micro_lamports,
        "Compute unit price does not match"
    );
    assert_eq!(
        retrieved_tx.status, expected.status,
        "Transaction status does not match"
    );
    assert_eq!(
        retrieved_tx.submission_attempts, expected.retries,
        "Transaction retries do not match"
    );
}
