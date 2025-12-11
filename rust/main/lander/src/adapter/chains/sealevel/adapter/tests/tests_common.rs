use std::sync::Arc;

use async_trait::async_trait;
use mockall::mock;
use solana_client::rpc_response::RpcSimulateTransactionResult;
use solana_sdk::account::Account;
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
    option_serializer::OptionSerializer, EncodedConfirmedTransactionWithStatusMeta,
    EncodedTransaction, EncodedTransactionWithStatusMeta, UiConfirmedBlock,
    UiTransactionStatusMeta,
};

use hyperlane_base::settings::{ChainConf, RawChainConf};
use hyperlane_core::{ChainResult, H512};
use hyperlane_sealevel::{
    fallback::SubmitSealevelRpc, PriorityFeeOracle, SealevelKeypair, SealevelProviderForLander,
    SealevelTxCostEstimate, TransactionSubmitter,
};

use crate::payload::FullPayload;
use crate::transaction::Transaction;

use super::super::{SealevelAdapter, SealevelTxPrecursor, TransactionFactory, Update};

pub const GAS_LIMIT: u32 = 42;

mock! {
    pub Client {}

    #[async_trait]
    impl SubmitSealevelRpc for Client {
        async fn get_block(&self, slot: u64) -> ChainResult<UiConfirmedBlock>;

        async fn get_block_with_commitment(
            &self,
            slot: u64,
            commitment: CommitmentConfig,
        ) -> ChainResult<UiConfirmedBlock>;

        async fn get_transaction(
            &self,
            signature: Signature,
        ) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta>;

        async fn get_transaction_with_commitment(
            &self,
            signature: Signature,
            commitment: CommitmentConfig,
        ) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta>;

        async fn simulate_transaction(
            &self,
            transaction: &SealevelTransaction,
        ) -> ChainResult<RpcSimulateTransactionResult>;
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

        async fn wait_for_transaction_confirmation(&self, transaction: &SealevelTransaction)
            -> ChainResult<()>;

        async fn confirm_transaction(
            &self,
            signature: Signature,
            commitment: CommitmentConfig,
        ) -> ChainResult<bool>;

        async fn get_account(&self, account: Pubkey) -> ChainResult<Option<Account>>;
    }
}

pub fn estimate() -> SealevelTxCostEstimate {
    SealevelTxCostEstimate {
        compute_units: GAS_LIMIT,
        compute_unit_price_micro_lamports: 0,
    }
}

pub fn adapter() -> SealevelAdapter {
    let client = mock_client();
    let oracle = MockOracle::new();
    let provider = create_default_mock_svm_provider();
    let submitter = mock_submitter();

    SealevelAdapter::new_internal_default(
        Arc::new(client),
        Arc::new(provider),
        Arc::new(oracle),
        Arc::new(submitter),
    )
}

pub fn adapter_config(conf: ChainConf) -> SealevelAdapter {
    let raw_conf = RawChainConf::default();
    let client = mock_client();
    let oracle = MockOracle::new();
    let provider = create_default_mock_svm_provider();
    let submitter = mock_submitter();

    SealevelAdapter::new_internal(
        conf,
        raw_conf,
        Arc::new(client),
        Arc::new(provider),
        Arc::new(oracle),
        Arc::new(submitter),
    )
    .unwrap()
}

pub fn adapter_with_mock_svm_provider(provider: MockSvmProvider) -> SealevelAdapter {
    let client = mock_client();
    let oracle = MockOracle::new();
    let submitter = mock_submitter();

    SealevelAdapter::new_internal_default(
        Arc::new(client),
        Arc::new(provider),
        Arc::new(oracle),
        Arc::new(submitter),
    )
}

fn create_default_mock_svm_provider() -> MockSvmProvider {
    let mut provider = MockSvmProvider::new();

    // Set up default expectations that existing tests expect
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
            let keypair = payer;
            Ok(SealevelTransaction::new_unsigned(Message::new(
                &[instruction],
                Some(&keypair.pubkey()),
            )))
        });

    provider
        .expect_wait_for_transaction_confirmation()
        .returning(|_| Ok(()));

    provider
        .expect_confirm_transaction()
        .returning(|_, _| Ok(true));

    // Default get_account returns None (account doesn't exist)
    provider.expect_get_account().returning(|_| Ok(None));

    provider
}

fn mock_submitter() -> MockSubmitter {
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

fn mock_client() -> MockClient {
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

pub fn svm_block() -> UiConfirmedBlock {
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

pub fn encoded_svm_transaction() -> EncodedConfirmedTransactionWithStatusMeta {
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

pub fn instruction() -> SealevelInstruction {
    ComputeBudgetInstruction::set_compute_unit_limit(GAS_LIMIT)
}

pub fn payload() -> FullPayload {
    let data = serde_json::to_vec(&instruction()).unwrap();

    FullPayload {
        data,
        ..Default::default()
    }
}

pub fn precursor() -> SealevelTxPrecursor {
    SealevelTxPrecursor::new(instruction(), estimate())
}

pub fn transaction() -> Transaction {
    let mut transaction = TransactionFactory::build(precursor(), &payload());
    transaction.update_after_submission(H512::zero(), precursor());

    transaction
}
