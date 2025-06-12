#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;
use hyperlane_core::accumulator::incremental::IncrementalMerkle;
use hyperlane_core::accumulator::TREE_DEPTH;
use hyperlane_core::{
    ChainResult, Checkpoint, CheckpointAtBlock, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, IncrementalMerkleAtBlock, MerkleTreeHook, ReorgPeriod,
    H256,
};
use starknet::accounts::SingleOwnerAccount;
use starknet::core::types::FieldElement;
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::merkle_tree_hook::MerkleTreeHook as StarknetMerkleTreeHookInternal;
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{
    build_single_owner_account, get_block_height_for_reorg_period, ConnectionConf, Signer,
    StarknetProvider,
};

impl<A> std::fmt::Display for StarknetMerkleTreeHookInternal<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// A reference to a Merkle Tree Hook contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetMerkleTreeHook {
    contract: StarknetMerkleTreeHookInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetMerkleTreeHook {
    /// Create a reference to a merkle tree hook at a specific Starknet address on some
    /// chain
    pub async fn new(
        conn: &ConnectionConf,
        locator: &ContractLocator<'_>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let account = build_single_owner_account(&conn.url, signer).await?;

        let hook_address: FieldElement = HyH256(locator.address)
            .try_into()
            .map_err(HyperlaneStarknetError::BytesConversionError)?;

        let contract = StarknetMerkleTreeHookInternal::new(hook_address, account);

        Ok(Self {
            contract,
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }

    #[allow(unused)]
    pub fn contract(
        &self,
    ) -> &StarknetMerkleTreeHookInternal<SingleOwnerAccount<AnyProvider, LocalWallet>> {
        &self.contract
    }
}

impl HyperlaneChain for StarknetMerkleTreeHook {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetMerkleTreeHook {
    fn address(&self) -> H256 {
        HyH256::from(self.contract.address).0
    }
}

#[async_trait]
impl MerkleTreeHook for StarknetMerkleTreeHook {
    #[instrument(skip(self))]
    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        let block_number =
            get_block_height_for_reorg_period(&self.provider.rpc_client(), reorg_period).await?;

        let (root, index) = self
            .contract
            .latest_checkpoint()
            .block_id(starknet::core::types::BlockId::Number(block_number))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok(CheckpointAtBlock {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: self.address(),
                mailbox_domain: self.domain().id(),
                root: H256::from_slice(root.to_bytes_be().as_slice()),
                index,
            },
            block_height: Some(block_number),
        })
    }

    #[instrument(skip(self))]
    #[allow(clippy::needless_range_loop)]
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        let block_number =
            get_block_height_for_reorg_period(&self.provider.rpc_client(), reorg_period).await?;

        let tree = self
            .contract
            .tree()
            .block_id(starknet::core::types::BlockId::Number(block_number))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        let mut branch = tree
            .branch
            .iter()
            .map(|b| H256::from_slice(b.value.to_bytes_be().as_slice()))
            .collect::<Vec<H256>>();
        branch.resize(TREE_DEPTH, H256::zero());

        Ok(IncrementalMerkleAtBlock {
            tree: IncrementalMerkle {
                branch: branch.try_into().unwrap(),
                count: tree.count.low.try_into().unwrap(),
            },
            block_height: Some(block_number),
        })
    }

    #[instrument(skip(self))]
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let block_number =
            get_block_height_for_reorg_period(&self.provider.rpc_client(), reorg_period).await?;

        let count = self
            .contract
            .count()
            .block_id(starknet::core::types::BlockId::Number(block_number))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok(count)
    }

    /// Get the latest checkpoint at a specific block height.
    async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock> {
        let (root, index) = self
            .contract
            .latest_checkpoint()
            .block_id(starknet::core::types::BlockId::Number(height))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok(CheckpointAtBlock {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: self.address(),
                mailbox_domain: self.domain().id(),
                root: H256::from_slice(root.to_bytes_be().as_slice()),
                index,
            },
            block_height: Some(height),
        })
    }
}
