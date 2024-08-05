#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::num::NonZeroU64;
use std::sync::Arc;

use async_trait::async_trait;
use cainome::cairo_serde::{CairoSerde, U256 as StarknetU256};
use hyperlane_core::accumulator::incremental::IncrementalMerkle;
use hyperlane_core::accumulator::TREE_DEPTH;
use hyperlane_core::{
    ChainResult, Checkpoint, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, MerkleTreeHook, H256,
};
use starknet::accounts::SingleOwnerAccount;
use starknet::providers::{AnyProvider, Provider};
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::merkle_tree_hook::MerkleTreeHook as StarknetMerkleTreeHookInternal;
use crate::error::HyperlaneStarknetError;
use crate::{build_single_owner_account, ConnectionConf, Signer, StarknetProvider};

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
    contract: Arc<StarknetMerkleTreeHookInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetMerkleTreeHook {
    /// Create a reference to a merkle tree hook at a specific Starknet address on some
    /// chain
    pub fn new(
        conn: &ConnectionConf,
        locator: &ContractLocator,
        signer: Signer,
    ) -> ChainResult<Self> {
        let account = build_single_owner_account(
            &conn.url,
            signer.local_wallet(),
            &signer.address,
            false,
            locator.domain.id(),
        );

        let contract = StarknetMerkleTreeHookInternal::new(
            locator
                .address
                .try_into()
                .map_err(HyperlaneStarknetError::BytesConversionError)?,
            account,
        );

        Ok(Self {
            contract: Arc::new(contract),
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
        &self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetMerkleTreeHook {
    fn address(&self) -> H256 {
        self.contract.address.into()
    }
}

#[async_trait]
impl MerkleTreeHook for StarknetMerkleTreeHook {
    #[instrument(skip(self))]
    async fn latest_checkpoint(&self, maybe_lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        let current_block = self
            .provider
            .rpc_client()
            .block_number()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        let (root, index) = match maybe_lag {
            Some(lag) => self
                .contract
                .latest_checkpoint()
                .block_id(starknet::core::types::BlockId::Number(
                    current_block - lag.get(),
                ))
                .call()
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?,
            None => self
                .contract
                .latest_checkpoint()
                .call()
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?,
        };

        Ok(Checkpoint {
            merkle_tree_hook_address: self.address(),
            mailbox_domain: self.domain().id(),
            root: H256::from_slice(root.to_bytes_be().as_slice()),
            index,
        })
    }

    #[instrument(skip(self))]
    #[allow(clippy::needless_range_loop)]
    async fn tree(&self, maybe_lag: Option<NonZeroU64>) -> ChainResult<IncrementalMerkle> {
        let tree = match maybe_lag {
            Some(lag) => self
                .contract
                .tree()
                .block_id(starknet::core::types::BlockId::Number(
                    self.provider
                        .rpc_client()
                        .block_number()
                        .await
                        .map_err(Into::<HyperlaneStarknetError>::into)?
                        - lag.get(),
                ))
                .call()
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?,
            None => self
                .contract
                .tree()
                .call()
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?,
        };

        let mut branch = tree
            .branch
            .iter()
            .map(|b| H256::from_slice(b.value.to_bytes_be().as_slice()))
            .collect::<Vec<H256>>();
        branch.resize(TREE_DEPTH, H256::zero());

        Ok(IncrementalMerkle {
            branch: branch.try_into().unwrap(),
            count: StarknetU256::cairo_serialized_size(&tree.count),
        })
    }

    #[instrument(skip(self))]
    async fn count(&self, maybe_lag: Option<NonZeroU64>) -> ChainResult<u32> {
        let count = match maybe_lag {
            Some(lag) => self
                .contract
                .count()
                .block_id(starknet::core::types::BlockId::Number(
                    self.provider
                        .rpc_client()
                        .block_number()
                        .await
                        .map_err(Into::<HyperlaneStarknetError>::into)?
                        - lag.get(),
                ))
                .call()
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?,
            None => self
                .contract
                .count()
                .call()
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?,
        };

        Ok(count)
    }
}

pub struct StarknetMerkleTreeHookAbi;

impl HyperlaneAbi for StarknetMerkleTreeHookAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        todo!()
    }
}
