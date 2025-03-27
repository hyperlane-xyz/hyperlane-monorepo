use async_trait::async_trait;
use eyre::Result;
use mockall::mock;
use solana_client::rpc_response::RpcSimulateTransactionResult;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction, instruction::Instruction, pubkey::Pubkey,
    signature::Signature, transaction::Transaction,
};
use solana_transaction_status::{EncodedConfirmedTransactionWithStatusMeta, UiConfirmedBlock};

use hyperlane_base::settings::parser::h_sealevel::{
    PriorityFeeOracle, SealevelKeypair, TransactionSubmitter,
};
use hyperlane_base::settings::ChainConf;
use hyperlane_core::{ChainResult, U256};
use hyperlane_sealevel::fallback::SealevelRpcClientForSubmitter;
use hyperlane_sealevel::{SealevelProvider, SealevelProviderForSubmitter, SealevelTxCostEstimate};

use crate::chain_tx_adapter::chains::sealevel::SealevelTxAdapter;
use crate::chain_tx_adapter::{AdaptsChain, SealevelPayload, SealevelTxPrecursor};
use crate::payload::{FullPayload, VmSpecificPayloadData};
use crate::transaction::VmSpecificTxData;

const GAS_LIMIT: u32 = 42;

mock! {
    pub RpcClient {}

    #[async_trait]
    impl SealevelRpcClientForSubmitter for RpcClient {
        async fn get_block(&self, slot: u64) -> ChainResult<UiConfirmedBlock>;
        async fn get_transaction(&self, signature: Signature) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta>;
        async fn simulate_transaction(&self, transaction: &Transaction) -> ChainResult<RpcSimulateTransactionResult>;
    }
}

mock! {
    pub Oracle {}

    #[async_trait]
    impl PriorityFeeOracle for Oracle {
        async fn get_priority_fee(&self, transaction: &Transaction) -> ChainResult<u64>;
    }
}

mock! {
    pub Submitter {}

    #[async_trait]
    impl TransactionSubmitter for Submitter {
        fn get_priority_fee_instruction(&self, compute_unit_price_micro_lamports: u64, compute_units: u64, payer: &Pubkey) -> Instruction;
        async fn send_transaction(&self, transaction: &Transaction, skip_preflight: bool) -> ChainResult<Signature>;
        fn get_provider(&self) -> Option<&'static SealevelProvider>;
    }
}

struct MockProvider {}

#[async_trait]
impl SealevelProviderForSubmitter for MockProvider {
    async fn create_transaction_for_instruction(
        &self,
        _compute_unit_limit: u32,
        _compute_unit_price_micro_lamports: u64,
        _instruction: Instruction,
        _payer: &SealevelKeypair,
        _tx_submitter: &dyn TransactionSubmitter,
        _sign: bool,
    ) -> ChainResult<Transaction> {
        todo!()
    }

    async fn get_estimated_costs_for_instruction(
        &self,
        _instruction: Instruction,
        _payer: &SealevelKeypair,
        _tx_submitter: &dyn TransactionSubmitter,
        _priority_fee_oracle: &dyn PriorityFeeOracle,
    ) -> ChainResult<SealevelTxCostEstimate> {
        Ok(SealevelTxCostEstimate {
            compute_units: GAS_LIMIT,
            compute_unit_price_micro_lamports: 0,
        })
    }

    async fn wait_for_transaction_confirmation(
        &self,
        _transaction: &Transaction,
    ) -> ChainResult<()> {
        todo!()
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
    matches!(result, Ok(_));
    assert_eq!(expected, result.unwrap());
}

#[tokio::test]
async fn test_build_transactions() {
    // given
    let adapter = adapter();
    let payload = payload();
    let expected = SealevelTxPrecursor::new(instruction(), estimate());

    // when
    let result = adapter.build_transactions(&[payload]).await;

    // then
    matches!(result, Ok(_));
    let precursor = actual_precursor(result);
    assert_eq!(&expected, precursor);
}

fn actual_precursor(result: Result<Vec<Transaction>>) -> &SealevelTxPrecursor {
    let transactions = result.unwrap();
    let transaction = transactions.first().unwrap();
    let precursor = match transaction.vm_specific_data() {
        VmSpecificTxData::Svm(p) => p,
        _ => panic!("testing Sealevel"),
    };
    precursor
}

fn estimate() -> SealevelTxCostEstimate {
    SealevelTxCostEstimate {
        compute_units: GAS_LIMIT,
        compute_unit_price_micro_lamports: 0,
    }
}

fn adapter() -> SealevelTxAdapter {
    let client = Box::new(MockRpcClient::new()) as Box<dyn SealevelRpcClientForSubmitter>;
    let oracle = Box::new(MockOracle::new()) as Box<dyn PriorityFeeOracle>;
    let provider = Box::new(MockProvider {}) as Box<dyn SealevelProviderForSubmitter>;
    let submitter = Box::new(MockSubmitter::new()) as Box<dyn TransactionSubmitter>;
    let adapter = SealevelTxAdapter::new_internal_default(client, provider, oracle, submitter);
    adapter
}

fn instruction() -> Instruction {
    ComputeBudgetInstruction::set_compute_unit_limit(GAS_LIMIT)
}

fn payload() -> FullPayload {
    let data = VmSpecificPayloadData::Svm(SealevelPayload {
        instruction: instruction(),
    });
    let payload = FullPayload {
        data,
        ..Default::default()
    };
    payload
}
