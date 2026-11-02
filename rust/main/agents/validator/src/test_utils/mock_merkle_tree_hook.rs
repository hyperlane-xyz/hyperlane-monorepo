use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, CheckpointAtBlock, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, IncrementalMerkleAtBlock, MerkleTreeHook, ReorgPeriod, H256,
};
use std::fmt::Debug;

mockall::mock! {
    pub MerkleTreeHook {}

    impl Debug for MerkleTreeHook {
        fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
    }

    impl HyperlaneChain for MerkleTreeHook {
        fn domain(&self) -> &HyperlaneDomain;
        fn provider(&self) -> Box<dyn HyperlaneProvider>;
    }

    impl HyperlaneContract for MerkleTreeHook {
        fn address(&self) -> H256;
    }

    #[async_trait]
    impl MerkleTreeHook for MerkleTreeHook {
        async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock>;
        async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32>;
        async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<CheckpointAtBlock>;
        async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock>;
    }
}
