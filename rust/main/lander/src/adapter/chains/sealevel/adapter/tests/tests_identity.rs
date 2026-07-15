use std::sync::{Arc, Mutex};

use solana_sdk::{instruction::AccountMeta, pubkey::Pubkey, signature::Keypair, signer::Signer};

use hyperlane_sealevel::{
    SealevelKeypair, SealevelProcessPayload, SealevelTxCostEstimate, SealevelTxType,
};

use crate::{adapter::AdaptsChain, payload::FullPayload};

use super::super::{SealevelAdapter, SealevelTxPrecursor, TransactionFactory};
use super::tests_common::{
    encoded_svm_transaction, estimate, svm_block, MockClient, MockOracle, MockSubmitter,
    MockSvmProvider,
};

fn make_adapter_with_identity(
    identity: SealevelKeypair,
    provider: MockSvmProvider,
) -> SealevelAdapter {
    let result = {
        use solana_client::rpc_response::RpcSimulateTransactionResult;
        RpcSimulateTransactionResult {
            err: None,
            logs: None,
            accounts: None,
            units_consumed: None,
            return_data: None,
            replacement_blockhash: None,
            inner_instructions: None,
            fee: None,
            loaded_accounts_data_size: None,
            loaded_addresses: None,
            post_balances: None,
            post_token_balances: None,
            pre_balances: None,
            pre_token_balances: None,
        }
    };

    let mut client = MockClient::new();
    client
        .expect_get_block_with_commitment()
        .returning(move |_, _| Ok(svm_block()));
    client
        .expect_get_transaction_with_commitment()
        .returning(move |_, _| Ok(encoded_svm_transaction()));
    let result_clone = result.clone();
    client
        .expect_simulate_transaction()
        .returning(move |_| Ok(result_clone.clone()));
    client
        .expect_simulate_versioned_transaction()
        .returning(move |_| Ok(result.clone()));

    let oracle = MockOracle::new();

    let mut submitter = MockSubmitter::new();
    submitter
        .expect_send_transaction()
        .returning(move |_, _| Ok(solana_sdk::signature::Signature::default()));
    submitter
        .expect_wait_for_transaction_confirmation()
        .returning(|_| Ok(()));
    submitter
        .expect_confirm_transaction()
        .returning(move |_, _| Ok(true));

    SealevelAdapter::new_internal_default_with_identity(
        identity,
        Arc::new(client),
        Arc::new(provider),
        Arc::new(oracle),
        Arc::new(submitter),
    )
}

fn mock_provider_capturing_signer_count(
    identity_pubkey: Pubkey,
    captured_count: Arc<Mutex<usize>>,
) -> MockSvmProvider {
    let mut provider = MockSvmProvider::new();
    provider
        .expect_get_estimated_costs_for_instruction()
        .returning(|_, _, _, _, _| {
            Ok(SealevelTxCostEstimate {
                compute_units: 42,
                compute_unit_price_micro_lamports: 0,
            })
        });
    provider
        .expect_create_transaction_for_instruction()
        .returning(
            move |_, _, instruction, payer, _, _, _, additional_signers| {
                // Verify the identity pubkey is present in additional_signers as expected
                let count = additional_signers
                    .iter()
                    .filter(|s| s.pubkey() == identity_pubkey)
                    .count();
                *captured_count.lock().unwrap() = count;

                use solana_sdk::{message::Message, transaction::Transaction};
                let tx =
                    Transaction::new_unsigned(Message::new(&[instruction], Some(&payer.pubkey())));
                Ok(SealevelTxType::Legacy(tx))
            },
        );
    provider
        .expect_wait_for_transaction_confirmation()
        .returning(|_| Ok(()));
    provider
        .expect_confirm_transaction()
        .returning(|_, _| Ok(true));
    provider.expect_get_account().returning(|_| Ok(None));
    provider
}

fn payload_and_precursor_with_identity_signer(
    identity_pubkey: Pubkey,
    is_signer: bool,
) -> (FullPayload, SealevelTxPrecursor) {
    use solana_compute_budget_interface::ComputeBudgetInstruction;

    let mut instruction = ComputeBudgetInstruction::set_compute_unit_limit(42);
    instruction
        .accounts
        .push(AccountMeta::new_readonly(identity_pubkey, is_signer));

    let process_payload = SealevelProcessPayload {
        instruction: instruction.clone(),
        alt_address: None,
    };
    let data = serde_json::to_vec(&process_payload).unwrap();
    let full_payload = FullPayload {
        data,
        ..Default::default()
    };
    let precursor = SealevelTxPrecursor::new(instruction, None, estimate());
    (full_payload, precursor)
}

/// When identity pubkey appears with `is_signer: true` (TrustedRelayer ISM), it co-signs.
#[tokio::test]
async fn test_identity_cosigns_when_account_is_signer() {
    let identity_keypair = Keypair::new();
    let identity_pubkey = identity_keypair.pubkey();
    let identity = SealevelKeypair::new(identity_keypair);

    let captured_count = Arc::new(Mutex::new(0usize));
    let provider = mock_provider_capturing_signer_count(identity_pubkey, captured_count.clone());

    let (payload, precursor) = payload_and_precursor_with_identity_signer(identity_pubkey, true);
    let adapter = make_adapter_with_identity(identity, provider);
    let mut transaction = TransactionFactory::build(precursor, &payload);

    adapter.submit(&mut transaction).await.unwrap();

    assert_eq!(
        *captured_count.lock().unwrap(),
        1,
        "identity should be added as co-signer when is_signer=true in accounts"
    );
}

/// When identity pubkey appears with `is_signer: false`, it must NOT co-sign.
#[tokio::test]
async fn test_identity_does_not_cosign_when_account_is_not_signer() {
    let identity_keypair = Keypair::new();
    let identity_pubkey = identity_keypair.pubkey();
    let identity = SealevelKeypair::new(identity_keypair);

    let captured_count = Arc::new(Mutex::new(0usize));
    let provider = mock_provider_capturing_signer_count(identity_pubkey, captured_count.clone());

    let (payload, precursor) = payload_and_precursor_with_identity_signer(identity_pubkey, false);
    let adapter = make_adapter_with_identity(identity, provider);
    let mut transaction = TransactionFactory::build(precursor, &payload);

    adapter.submit(&mut transaction).await.unwrap();

    assert_eq!(
        *captured_count.lock().unwrap(),
        0,
        "identity should NOT be added as co-signer when is_signer=false in accounts"
    );
}
