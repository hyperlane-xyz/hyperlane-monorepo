use async_trait::async_trait;
use eyre::Result;
use mockall::mock;
use solana_client::rpc_response::RpcSimulateTransactionResult;
use solana_sdk::{
    instruction::Instruction, pubkey::Pubkey, signature::Signature, transaction::Transaction,
};
use solana_transaction_status::{EncodedConfirmedTransactionWithStatusMeta, UiConfirmedBlock};

use hyperlane_base::settings::parser::h_sealevel::{
    PriorityFeeOracle, SealevelKeypair, TransactionSubmitter,
};
use hyperlane_core::ChainResult;
use hyperlane_sealevel::fallback::SealevelRpcClientForSubmitter;
use hyperlane_sealevel::{SealevelProvider, SealevelTxCostEstimate};

mock! {
    pub MockRpcClient {}

    #[async_trait]
    impl SealevelRpcClientForSubmitter for MockRpcClient {
        async fn get_block(&self, slot: u64) -> ChainResult<UiConfirmedBlock>;
        async fn get_transaction(&self, signature: Signature) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta>;
        async fn simulate_transaction(&self, transaction: &Transaction) -> ChainResult<RpcSimulateTransactionResult>;
    }
}

mock! {
    pub MockPriorityFeeOracle {}

    #[async_trait]
    impl PriorityFeeOracle for MockPriorityFeeOracle {
        async fn get_priority_fee(&self, transaction: &Transaction) -> ChainResult<u64>;
    }
}

mock! {
    pub MockTransactionSubmitter {}

    #[async_trait]
    impl TransactionSubmitter for MockTransactionSubmitter {
        fn get_priority_fee_instruction(&self, compute_unit_price_micro_lamports: u64, compute_units: u64, payer: &Pubkey) -> Instruction;
        async fn send_transaction(&self, transaction: &Transaction, skip_preflight: bool) -> ChainResult<Signature>;
        fn get_provider(&self) -> Option<&'static SealevelProvider>;
    }
}
