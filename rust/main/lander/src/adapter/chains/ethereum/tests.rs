use std::convert::Into;
use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::{
    abi::Function,
    prelude::{Block, BlockNumber, FeeHistory, TransactionReceipt},
    types::{transaction::eip2718::TypedTransaction, Address, H160, H256 as EthersH256},
};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, CheckpointAtBlock, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, IncrementalMerkleAtBlock, KnownHyperlaneDomain,
    MerkleTreeHook, ReorgPeriod, H256, U256,
};
use hyperlane_ethereum::{
    BatchCache, EthereumReorgPeriod, EvmProviderForLander, ZksyncEstimateFeeResponse,
};

mockall::mock! {
    pub EvmProvider {}

    #[async_trait]
    impl EvmProviderForLander for EvmProvider {
        /// Get the transaction receipt for a given transaction hash
        async fn get_transaction_receipt(
            &self,
            transaction_hash: H256,
        ) -> ChainResult<Option<TransactionReceipt>>;

        /// Get the finalized block number
        async fn get_finalized_block_number(
            &self,
            reorg_period: &EthereumReorgPeriod,
        ) -> ChainResult<u32>;

        /// Get the block for a given block number
        async fn get_block(&self, block_number: BlockNumber) -> ChainResult<Option<Block<EthersH256>>>;

        /// Estimate the gas limit for a transaction
        async fn estimate_gas_limit(
            &self,
            tx: &TypedTransaction,
            function: &Function,
        ) -> ChainResult<U256>;

        async fn batch(
            &self,
            cache: Arc<tokio::sync::Mutex<BatchCache>>,
            batch_contract_address: H256,
            precursors: Vec<(TypedTransaction, Function)>
        ) -> ChainResult<(TypedTransaction, Function)>;

        async fn simulate(
            &self,
            cache: Arc<tokio::sync::Mutex<BatchCache>>,
            batch_contract_address: H256,
            precursors: Vec<(TypedTransaction, Function)>,
        ) -> ChainResult<(Vec<usize>, Vec<usize>)>;

        async fn estimate_batch(
            &self,
            multi_precursor: (TypedTransaction, Function),
            precursors: Vec<(TypedTransaction, Function)>,
        ) -> ChainResult<U256>;

        /// Send transaction into blockchain
        async fn send(&self, tx: &TypedTransaction, function: &Function) -> ChainResult<H256>;

        /// Read-only call into blockchain which returns a boolean
        async fn check(&self, tx: &TypedTransaction, function: &Function) -> ChainResult<bool>;

        /// Get the next nonce to use for a given address (using the finalized block)
        async fn get_next_nonce_on_finalized_block(&self, address: &Address, reorg_period: &EthereumReorgPeriod) -> ChainResult<U256>;

        /// Get the fee history
        async fn fee_history(
            &self,
            block_count: U256,
            last_block: BlockNumber,
            reward_percentiles: &[f64],
        ) -> ChainResult<FeeHistory>;

        /// Estimate the fee for a zkSync transaction
        async fn zk_estimate_fee(
            &self,
            tx: &TypedTransaction,
        ) -> ChainResult<ZksyncEstimateFeeResponse>;

        /// Get default sender
        fn get_signer(&self) -> Option<H160>;
    }
}
