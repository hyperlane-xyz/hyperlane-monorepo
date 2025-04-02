use std::sync::Arc;

use async_trait::async_trait;
use eyre::Result;
use mockall::mock;
use solana_client::rpc_response::RpcSimulateTransactionResult;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::Instruction as SealevelInstruction,
    message::Message,
    pubkey::Pubkey,
    signature::{Signature, Signer},
    transaction::Transaction as SealevelTransaction,
};
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, EncodedTransaction,
    EncodedTransactionWithStatusMeta, UiConfirmedBlock,
};

use hyperlane_base::settings::parser::h_sealevel::{
    PriorityFeeOracle, SealevelKeypair, TransactionSubmitter,
};
use hyperlane_base::settings::ChainConf;
use hyperlane_core::{ChainResult, H512, U256};
use hyperlane_sealevel::fallback::SubmitSealevelRpc;
use hyperlane_sealevel::{SealevelProvider, SealevelProviderForSubmitter, SealevelTxCostEstimate};

use crate::chain_tx_adapter::AdaptsChain;
use crate::chain_tx_adapter::{
    chains::sealevel::transaction::{TransactionFactory, Update},
    TxBuildingResult,
};
use crate::payload::{FullPayload, PayloadDetails, VmSpecificPayloadData};
use crate::transaction::{SignerAddress, Transaction, TransactionStatus, VmSpecificTxData};
use crate::{
    chain_tx_adapter::chains::sealevel::{SealevelPayload, SealevelTxAdapter, SealevelTxPrecursor},
    error::SubmitterError,
};

const GAS_LIMIT: u32 = 42;

mock! {
    pub Client {}

    #[async_trait]
    impl SubmitSealevelRpc for Client {
        async fn get_block(&self, slot: u64) -> ChainResult<UiConfirmedBlock>;
        async fn get_transaction(&self, signature: Signature) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta>;
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

struct MockProvider {}

#[async_trait]
impl SealevelProviderForSubmitter for MockProvider {
    async fn create_transaction_for_instruction(
        &self,
        _compute_unit_limit: u32,
        _compute_unit_price_micro_lamports: u64,
        _instruction: SealevelInstruction,
        _payer: &SealevelKeypair,
        _tx_submitter: &dyn TransactionSubmitter,
        _sign: bool,
    ) -> ChainResult<SealevelTransaction> {
        let keypair = SealevelKeypair::default();
        Ok(SealevelTransaction::new_unsigned(Message::new(
            &[instruction()],
            Some(&keypair.pubkey()),
        )))
    }

    async fn get_estimated_costs_for_instruction(
        &self,
        _instruction: SealevelInstruction,
        _payer: &SealevelKeypair,
        _tx_submitter: &dyn TransactionSubmitter,
        _priority_fee_oracle: &dyn PriorityFeeOracle,
    ) -> ChainResult<Option<SealevelTxCostEstimate>> {
        Ok(Some(SealevelTxCostEstimate {
            compute_units: GAS_LIMIT,
            compute_unit_price_micro_lamports: 0,
        }))
    }

    async fn wait_for_transaction_confirmation(
        &self,
        _transaction: &SealevelTransaction,
    ) -> ChainResult<()> {
        Ok(())
    }

    async fn confirm_transaction(
        &self,
        _signature: Signature,
        _commitment: CommitmentConfig,
    ) -> ChainResult<bool> {
        Ok(true)
    }
}

#[tokio::test]
async fn test_estimate_gas_limit() {
    // given
    let adapter = adapter();
    let payload = payload();

    let expected = U256::from(GAS_LIMIT);

    // when
    let result = adapter.estimate_gas_limit(&payload).await;

    // then
    assert!(result.is_ok());
    assert_eq!(expected, result.unwrap().unwrap());
}

#[tokio::test]
async fn test_build_transactions() {
    // given
    let adapter = adapter();
    let payload = payload();
    let data = VmSpecificTxData::Svm(SealevelTxPrecursor::new(instruction(), estimate()));
    let expected = (payload.details.clone(), data);

    // when
    let result = adapter.build_transactions(&[payload.clone()]).await;

    // then
    assert!(result.is_ok());
    let actual = payload_details_and_data_in_transaction(result);
    assert_eq!(expected, actual);
}

#[tokio::test]
async fn test_simulate_tx() {
    // given
    let adapter = adapter();
    let transaction = TransactionFactory::build(&payload(), precursor());

    // when
    let simulated = adapter.simulate_tx(&transaction).await.unwrap();

    // then
    assert!(simulated);
}

#[tokio::test]
async fn test_submit() {
    // given
    let adapter = adapter();
    let mut transaction = TransactionFactory::build(&payload(), precursor());

    // when
    let result = adapter.submit(&mut transaction).await;

    // then
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_tx_status() {
    // given
    let adapter = adapter();
    let transaction = transaction();

    // when
    let result = adapter.tx_status(&transaction).await;

    // then
    assert!(result.is_ok());
    let status = result.unwrap();
    assert!(matches!(status, TransactionStatus::Finalized));
}

fn payload_details_and_data_in_transaction(
    result: Result<Vec<TxBuildingResult>, SubmitterError>,
) -> (PayloadDetails, VmSpecificTxData) {
    let transactions = result.unwrap();
    let built_tx = transactions.first().unwrap();
    let first_tx = built_tx.maybe_tx.clone().unwrap();
    (
        first_tx.payload_details.first().unwrap().clone(),
        first_tx.vm_specific_data.clone(),
    )
}

fn estimate() -> SealevelTxCostEstimate {
    SealevelTxCostEstimate {
        compute_units: GAS_LIMIT,
        compute_unit_price_micro_lamports: 0,
    }
}

fn adapter() -> SealevelTxAdapter {
    let client = mock_client();
    let oracle = MockOracle::new();
    let provider = MockProvider {};
    let submitter = mock_submitter();

    SealevelTxAdapter::new_internal_default(
        Box::new(client),
        Box::new(provider),
        Box::new(oracle),
        Box::new(submitter),
    )
}

fn mock_submitter() -> MockSubmitter {
    let signature = Signature::default();

    let mut submitter = MockSubmitter::new();
    submitter
        .expect_send_transaction()
        .returning(move |_, _| Ok(signature));
    submitter
        .expect_wait_for_transaction_confirmation()
        .returning(move |_| Ok(()));
    submitter
        .expect_confirm_transaction()
        .returning(move |_, _| Ok(true));
    submitter
}

fn mock_client() -> MockClient {
    let result = RpcSimulateTransactionResult {
        err: None,
        logs: None,
        accounts: None,
        units_consumed: None,
        return_data: None,
    };

    let mut client = MockClient::new();
    client.expect_get_block().returning(move |_| Ok(block()));
    client
        .expect_get_transaction()
        .returning(move |_| Ok(encoded_transaction()));
    client
        .expect_simulate_transaction()
        .returning(move |_| Ok(result.clone()));
    client
}

fn block() -> UiConfirmedBlock {
    UiConfirmedBlock {
        previous_blockhash: "".to_string(),
        blockhash: "".to_string(),
        parent_slot: 0,
        transactions: None,
        signatures: None,
        rewards: None,
        block_time: None,
        block_height: None,
    }
}

fn encoded_transaction() -> EncodedConfirmedTransactionWithStatusMeta {
    EncodedConfirmedTransactionWithStatusMeta {
        slot: 43,
        transaction: EncodedTransactionWithStatusMeta {
            transaction: EncodedTransaction::LegacyBinary("binary".to_string()),
            meta: None,
            version: None,
        },
        block_time: None,
    }
}

fn instruction() -> SealevelInstruction {
    ComputeBudgetInstruction::set_compute_unit_limit(GAS_LIMIT)
}

fn payload() -> FullPayload {
    let data = VmSpecificPayloadData::Svm(SealevelPayload {
        instruction: instruction(),
    });

    FullPayload {
        data,
        ..Default::default()
    }
}

fn precursor() -> SealevelTxPrecursor {
    SealevelTxPrecursor::new(instruction(), estimate())
}

fn transaction() -> Transaction {
    let mut transaction = TransactionFactory::build(&payload(), precursor());
    transaction.update_after_submission(H512::zero(), precursor());

    transaction
}
