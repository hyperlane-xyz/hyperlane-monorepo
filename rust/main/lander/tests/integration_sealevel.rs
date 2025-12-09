//! Integration tests for Lander with Sealevel (Solana) adapter
//!
//! These tests use a real SealevelAdapter implementation with mocked providers,
//! validating the full dispatcher pipeline with realistic Sealevel transaction building.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use mockall::mock;
use solana_client::rpc_response::RpcSimulateTransactionResult;
use solana_sdk::{
    account::Account, commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction, instruction::Instruction as SealevelInstruction,
    message::Message, pubkey::Pubkey, signature::Signature, signature::Signer,
    transaction::Transaction as SealevelTransaction,
};
use solana_transaction_status::{
    option_serializer::OptionSerializer, EncodedConfirmedTransactionWithStatusMeta,
    EncodedTransaction, EncodedTransactionWithStatusMeta, UiConfirmedBlock,
    UiTransactionStatusMeta,
};

use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_core::{ChainResult, HyperlaneDomain, KnownHyperlaneDomain};
use hyperlane_sealevel::{
    fallback::SubmitSealevelRpc, PriorityFeeOracle, SealevelKeypair, SealevelProviderForLander,
    SealevelTxCostEstimate, TransactionSubmitter,
};

use lander::{
    Entrypoint, FullPayload, PayloadDb, PayloadStatus, PayloadUuid, TransactionDb,
    TransactionStatus,
};

const GAS_LIMIT: u32 = 42;

// Mock definitions - duplicated from adapter tests since they're not exported
mock! {
    pub Client {}

    #[async_trait]
    impl SubmitSealevelRpc for Client {
        async fn get_block(&self, slot: u64) -> ChainResult<UiConfirmedBlock>;
        async fn get_block_with_commitment(&self, slot: u64, commitment: CommitmentConfig) -> ChainResult<UiConfirmedBlock>;
        async fn get_transaction(&self, signature: Signature) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta>;
        async fn get_transaction_with_commitment(&self, signature: Signature, commitment: CommitmentConfig) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta>;
        async fn simulate_transaction(&self, transaction: &SealevelTransaction) -> ChainResult<RpcSimulateTransactionResult>;
    }
}

mock! {
    pub Oracle {}

    #[async_trait]
    impl PriorityFeeOracle for Oracle {
        async fn get_priority_fee(&self, transaction: &SealevelTransaction) -> ChainResult<u64>;
    }
}

mock! {
    pub Submitter {}

    #[async_trait]
    impl TransactionSubmitter for Submitter {
        fn get_priority_fee_instruction(&self, compute_unit_price_micro_lamports: u64, compute_units: u64, payer: &Pubkey) -> SealevelInstruction;
        async fn send_transaction(&self, transaction: &SealevelTransaction, skip_preflight: bool) -> ChainResult<Signature>;
        async fn wait_for_transaction_confirmation(&self, transaction: &SealevelTransaction) -> ChainResult<()>;
        async fn confirm_transaction(&self, signature: Signature, commitment: CommitmentConfig) -> ChainResult<bool>;
    }
}

mock! {
    pub SvmProvider {}

    #[async_trait]
    impl SealevelProviderForLander for SvmProvider {
        async fn create_transaction_for_instruction(
            &self,
            compute_unit_limit: u32,
            compute_unit_price_micro_lamports: u64,
            instruction: SealevelInstruction,
            payer: &SealevelKeypair,
            tx_submitter: Arc<dyn TransactionSubmitter>,
            sign: bool,
        ) -> ChainResult<SealevelTransaction>;

        async fn get_estimated_costs_for_instruction(
            &self,
            instruction: SealevelInstruction,
            payer: &SealevelKeypair,
            tx_submitter: Arc<dyn TransactionSubmitter>,
            priority_fee_oracle: Arc<dyn PriorityFeeOracle>,
        ) -> ChainResult<SealevelTxCostEstimate>;

        async fn wait_for_transaction_confirmation(&self, transaction: &SealevelTransaction) -> ChainResult<()>;
        async fn confirm_transaction(&self, signature: Signature, commitment: CommitmentConfig) -> ChainResult<bool>;
        async fn get_account(&self, account: Pubkey) -> ChainResult<Option<Account>>;
    }
}

// Helper functions

fn tmp_dbs() -> (Arc<dyn PayloadDb>, Arc<dyn TransactionDb>) {
    let temp_dir = tempfile::tempdir().unwrap();
    let db = DB::from_path(temp_dir.path()).unwrap();
    let domain: HyperlaneDomain = KnownHyperlaneDomain::Arbitrum.into();
    let rocksdb = Arc::new(HyperlaneRocksDB::new(&domain, db));

    let payload_db = rocksdb.clone() as Arc<dyn PayloadDb>;
    let tx_db = rocksdb.clone() as Arc<dyn TransactionDb>;
    (payload_db, tx_db)
}

fn create_sealevel_provider_for_successful_tx() -> MockSvmProvider {
    let mut provider = MockSvmProvider::new();

    provider
        .expect_get_estimated_costs_for_instruction()
        .returning(|_, _, _, _| {
            Ok(SealevelTxCostEstimate {
                compute_units: GAS_LIMIT,
                compute_unit_price_micro_lamports: 0,
            })
        });

    provider
        .expect_create_transaction_for_instruction()
        .returning(|_, _, instruction, payer, _, _| {
            Ok(SealevelTransaction::new_unsigned(Message::new(
                &[instruction],
                Some(&payer.pubkey()),
            )))
        });

    provider
        .expect_wait_for_transaction_confirmation()
        .returning(|_| Ok(()));

    provider
        .expect_confirm_transaction()
        .returning(|_, _| Ok(true));

    provider.expect_get_account().returning(|_| Ok(None));

    provider
}

fn create_sealevel_client() -> MockClient {
    let result = RpcSimulateTransactionResult {
        err: None,
        logs: None,
        accounts: None,
        units_consumed: None,
        return_data: None,
    };

    let mut client = MockClient::new();
    client
        .expect_get_block_with_commitment()
        .returning(move |_, _| Ok(svm_block()));
    client
        .expect_get_transaction_with_commitment()
        .returning(move |_, _| Ok(encoded_svm_transaction()));
    client
        .expect_simulate_transaction()
        .returning(move |_| Ok(result.clone()));
    client
}

fn create_sealevel_submitter() -> MockSubmitter {
    let signature = Signature::default();

    let mut submitter = MockSubmitter::new();
    submitter
        .expect_send_transaction()
        .returning(move |_, _| Ok(signature));
    submitter
        .expect_wait_for_transaction_confirmation()
        .returning(|_| Ok(()));
    submitter
        .expect_confirm_transaction()
        .returning(move |_, _| Ok(true));
    submitter
}

fn svm_block() -> UiConfirmedBlock {
    UiConfirmedBlock {
        previous_blockhash: String::new(),
        blockhash: String::new(),
        parent_slot: 0,
        transactions: None,
        signatures: None,
        rewards: None,
        block_time: None,
        block_height: None,
    }
}

fn encoded_svm_transaction() -> EncodedConfirmedTransactionWithStatusMeta {
    EncodedConfirmedTransactionWithStatusMeta {
        slot: 43,
        transaction: EncodedTransactionWithStatusMeta {
            transaction: EncodedTransaction::LegacyBinary("binary".to_string()),
            meta: Some(UiTransactionStatusMeta {
                err: None,
                status: Ok(()),
                fee: 0,
                pre_balances: Vec::new(),
                post_balances: Vec::new(),
                inner_instructions: OptionSerializer::None,
                log_messages: OptionSerializer::None,
                pre_token_balances: OptionSerializer::None,
                post_token_balances: OptionSerializer::None,
                rewards: OptionSerializer::None,
                loaded_addresses: OptionSerializer::None,
                return_data: OptionSerializer::None,
                compute_units_consumed: OptionSerializer::None,
            }),
            version: None,
        },
        block_time: None,
    }
}

fn create_sealevel_payload() -> FullPayload {
    let instruction = ComputeBudgetInstruction::set_compute_unit_limit(GAS_LIMIT);
    let data = serde_json::to_vec(&instruction).unwrap();

    FullPayload {
        data,
        ..Default::default()
    }
}

/// Helper to wait for a payload to reach a specific status
async fn wait_until_payload_status<F, E>(
    entrypoint: &E,
    payload_uuid: &PayloadUuid,
    status_check: F,
    timeout: Duration,
) -> Result<PayloadStatus, String>
where
    F: Fn(&PayloadStatus) -> bool,
    E: Entrypoint,
{
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > timeout {
            return Err(format!(
                "Timeout waiting for payload status after {timeout:?}"
            ));
        }

        match entrypoint.payload_status(payload_uuid.clone()).await {
            Ok(status) => {
                if status_check(&status) {
                    return Ok(status);
                }
            }
            Err(e) => return Err(format!("Failed to get payload status: {e}")),
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Test that a Sealevel payload reaches finalized status through the full dispatcher pipeline
#[tokio::test]
async fn test_sealevel_payload_reaches_finalized_status() {
    let payload = create_sealevel_payload();

    // Create Sealevel adapter with mocked providers
    let client = create_sealevel_client();
    let provider = create_sealevel_provider_for_successful_tx();
    let oracle = MockOracle::new();
    let submitter = create_sealevel_submitter();

    let adapter = lander::create_test_sealevel_adapter(
        Arc::new(client),
        Arc::new(provider),
        Arc::new(oracle),
        Arc::new(submitter),
        Duration::from_millis(100),
    );

    // Create dispatcher with real Sealevel adapter
    let (payload_db, tx_db) = tmp_dbs();
    let (entrypoint, dispatcher) =
        lander::create_test_dispatcher(adapter, payload_db, tx_db, "sealevel".to_string()).await;

    // Spawn dispatcher
    let _dispatcher_handle = tokio::spawn(async move { dispatcher.spawn().await.await });

    // Send payload
    entrypoint
        .send_payload(&payload)
        .await
        .expect("Failed to send payload");

    // Wait for finalized status
    let final_status = wait_until_payload_status(
        &entrypoint,
        payload.uuid(),
        |status| {
            matches!(
                status,
                PayloadStatus::InTransaction(TransactionStatus::Finalized)
            )
        },
        Duration::from_secs(5),
    )
    .await
    .expect("Payload did not reach finalized status");

    // Verify
    assert!(
        matches!(
            final_status,
            PayloadStatus::InTransaction(TransactionStatus::Finalized)
        ),
        "Expected finalized status, got: {final_status:?}"
    );
}

/// Test that simulation failure results in dropped payload status
#[tokio::test]
async fn test_sealevel_payload_simulation_failure_results_in_dropped() {
    let payload = create_sealevel_payload();

    // Create Sealevel adapter with simulation failure
    let mut client = MockClient::new();
    client
        .expect_get_block_with_commitment()
        .returning(move |_, _| Ok(svm_block()));
    client
        .expect_get_transaction_with_commitment()
        .returning(move |_, _| Ok(encoded_svm_transaction()));
    // Simulation fails
    client
        .expect_simulate_transaction()
        .returning(|_| Err(eyre::eyre!("Simulation failed").into()));

    let provider = create_sealevel_provider_for_successful_tx();
    let oracle = MockOracle::new();
    let submitter = create_sealevel_submitter();

    let adapter = lander::create_test_sealevel_adapter(
        Arc::new(client),
        Arc::new(provider),
        Arc::new(oracle),
        Arc::new(submitter),
        Duration::from_millis(100),
    );

    // Create dispatcher
    let (payload_db, tx_db) = tmp_dbs();
    let (entrypoint, dispatcher) =
        lander::create_test_dispatcher(adapter, payload_db, tx_db, "sealevel".to_string()).await;

    let _dispatcher_handle = tokio::spawn(async move { dispatcher.spawn().await.await });

    // Send payload
    entrypoint
        .send_payload(&payload)
        .await
        .expect("Failed to send payload");

    // Wait for dropped status
    let final_status = wait_until_payload_status(
        &entrypoint,
        payload.uuid(),
        |status| {
            matches!(
                status,
                PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
            )
        },
        Duration::from_secs(5),
    )
    .await
    .expect("Payload did not reach dropped status");

    // Verify
    assert!(
        matches!(
            final_status,
            PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
        ),
        "Expected dropped status, got: {final_status:?}"
    );
}

/// Test that estimation failure results in dropped payload status
#[tokio::test]
async fn test_sealevel_payload_estimation_failure_results_in_dropped() {
    let payload = create_sealevel_payload();

    // Create Sealevel adapter with estimation failure
    let client = create_sealevel_client();

    let mut provider = MockSvmProvider::new();
    // Estimation fails
    provider
        .expect_get_estimated_costs_for_instruction()
        .returning(|_, _, _, _| Err(eyre::eyre!("Estimation failed").into()));

    provider
        .expect_create_transaction_for_instruction()
        .returning(|_, _, instruction, payer, _, _| {
            Ok(SealevelTransaction::new_unsigned(Message::new(
                &[instruction],
                Some(&payer.pubkey()),
            )))
        });

    provider
        .expect_wait_for_transaction_confirmation()
        .returning(|_| Ok(()));

    provider
        .expect_confirm_transaction()
        .returning(|_, _| Ok(true));

    provider.expect_get_account().returning(|_| Ok(None));

    let oracle = MockOracle::new();
    let submitter = create_sealevel_submitter();

    let adapter = lander::create_test_sealevel_adapter(
        Arc::new(client),
        Arc::new(provider),
        Arc::new(oracle),
        Arc::new(submitter),
        Duration::from_millis(100),
    );

    // Create dispatcher
    let (payload_db, tx_db) = tmp_dbs();
    let (entrypoint, dispatcher) =
        lander::create_test_dispatcher(adapter, payload_db, tx_db, "sealevel".to_string()).await;

    let _dispatcher_handle = tokio::spawn(async move { dispatcher.spawn().await.await });

    // Send payload
    entrypoint
        .send_payload(&payload)
        .await
        .expect("Failed to send payload");

    // Wait for dropped status
    let final_status = wait_until_payload_status(
        &entrypoint,
        payload.uuid(),
        |status| {
            matches!(
                status,
                PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
            )
        },
        Duration::from_secs(5),
    )
    .await
    .expect("Payload did not reach dropped status");

    // Verify
    assert!(
        matches!(
            final_status,
            PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
        ),
        "Expected dropped status, got: {final_status:?}"
    );
}

/// Test that payload_status returns an error for non-existent payloads
#[tokio::test]
async fn test_sealevel_payload_status_nonexistent_payload() {
    // Create Sealevel adapter
    let client = create_sealevel_client();
    let provider = create_sealevel_provider_for_successful_tx();
    let oracle = MockOracle::new();
    let submitter = create_sealevel_submitter();

    let adapter = lander::create_test_sealevel_adapter(
        Arc::new(client),
        Arc::new(provider),
        Arc::new(oracle),
        Arc::new(submitter),
        Duration::from_millis(100),
    );

    let (payload_db, tx_db) = tmp_dbs();
    let (entrypoint, _dispatcher) =
        lander::create_test_dispatcher(adapter, payload_db, tx_db, "sealevel".to_string()).await;

    let non_existent_uuid = PayloadUuid::random();
    let result = entrypoint.payload_status(non_existent_uuid).await;

    // Should return an error or ReadyToSubmit for non-existent payload
    assert!(
        result.is_err() || matches!(result.unwrap(), PayloadStatus::ReadyToSubmit),
        "Expected error or ReadyToSubmit for non-existent payload"
    );
}
