use std::sync::Arc;

use async_trait::async_trait;
use mockall::mock;
use solana_client::rpc_response::RpcSimulateTransactionResult;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::Instruction as SealevelInstruction;
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Signature, Signer};
use solana_sdk::transaction::Transaction as SealevelTransaction;
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, EncodedTransaction,
    EncodedTransactionWithStatusMeta, UiConfirmedBlock,
};

use hyperlane_base::settings::{ChainConf, RawChainConf};
use hyperlane_core::{ChainResult, H512};
use hyperlane_sealevel::fallback::SubmitSealevelRpc;
use hyperlane_sealevel::{
    PriorityFeeOracle, SealevelKeypair, SealevelProviderForSubmitter, SealevelTxCostEstimate,
    TransactionSubmitter,
};

use crate::chain_tx_adapter::chains::sealevel::transaction::{TransactionFactory, Update};
use crate::chain_tx_adapter::chains::sealevel::SealevelTxAdapter;
use crate::chain_tx_adapter::SealevelTxPrecursor;
use crate::payload::FullPayload;
use crate::transaction::{Transaction, VmSpecificTxData};

pub const GAS_LIMIT: u32 = 42;

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

pub fn estimate() -> SealevelTxCostEstimate {
    SealevelTxCostEstimate {
        compute_units: GAS_LIMIT,
        compute_unit_price_micro_lamports: 0,
    }
}

pub fn adapter() -> SealevelTxAdapter {
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

pub fn adapter_config(conf: ChainConf) -> SealevelTxAdapter {
    let raw_conf = RawChainConf::default();
    let client = mock_client();
    let oracle = MockOracle::new();
    let provider = MockProvider {};
    let submitter = mock_submitter();

    SealevelTxAdapter::new_internal(
        conf,
        raw_conf,
        Box::new(client),
        Box::new(provider),
        Box::new(oracle),
        Box::new(submitter),
    )
    .unwrap()
}

fn mock_submitter() -> MockSubmitter {
    let signature = Signature::default();

    let mut submitter = MockSubmitter::new();
    submitter
        .expect_send_transaction()
        .returning(move |_, _| Ok(signature.clone()));
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

pub fn instruction() -> SealevelInstruction {
    ComputeBudgetInstruction::set_compute_unit_limit(GAS_LIMIT)
}

pub fn payload() -> FullPayload {
    let data = serde_json::to_vec(&instruction()).unwrap();
    let payload = FullPayload {
        data,
        ..Default::default()
    };
    payload
}

pub fn precursor() -> SealevelTxPrecursor {
    SealevelTxPrecursor::new(instruction(), estimate())
}

pub fn transaction() -> Transaction {
    let mut transaction = TransactionFactory::build(&payload(), precursor());
    transaction.update_after_submission(H512::zero(), precursor());

    transaction
}
