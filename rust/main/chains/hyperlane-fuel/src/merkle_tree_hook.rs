use crate::{
    contracts::merkle_tree_hook::{
        InsertedIntoTreeEvent, MerkleTreeHook as MerkleTreeHookContract,
    },
    conversions::*,
    ConnectionConf, FuelIndexer, FuelProvider,
};
use async_trait::async_trait;
use fuels::{
    accounts::wallet::WalletUnlocked, programs::calls::Execution, types::bech32::Bech32ContractId,
};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult, Checkpoint,
    ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider,
    Indexed, Indexer, LogMeta, MerkleTreeHook, MerkleTreeInsertion, ReorgPeriod,
    SequenceAwareIndexer, H256,
};
use std::ops::RangeInclusive;

/// A reference to a MerkleTreeHook contract on some Fuel chain
#[derive(Debug)]
pub struct FuelMerkleTreeHook {
    contract: MerkleTreeHookContract<WalletUnlocked>,
    domain: HyperlaneDomain,
    provider: FuelProvider,
}

impl FuelMerkleTreeHook {
    /// Create a new fuel validator announce contract
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        wallet.set_provider(fuel_provider.provider().clone());
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelMerkleTreeHook {
            contract: MerkleTreeHookContract::new(address, wallet),
            domain: locator.domain.clone(),
            provider: fuel_provider,
        })
    }
}

impl HyperlaneContract for FuelMerkleTreeHook {
    fn address(&self) -> H256 {
        self.contract.contract_id().into_h256()
    }
}

impl HyperlaneChain for FuelMerkleTreeHook {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl MerkleTreeHook for FuelMerkleTreeHook {
    async fn tree(&self, _reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkle> {
        self.contract
            .methods()
            .tree()
            .simulate(Execution::StateReadOnly)
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to fetch tree from MerkleTreeHook contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })
            .map(|res| {
                let merkle_tree = res.value;
                IncrementalMerkle {
                    branch: merkle_tree.branch.into_h256_array(),
                    count: merkle_tree.count as usize,
                }
            })
    }

    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        self.contract
            .methods()
            .count()
            .simulate(Execution::StateReadOnly)
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to fetch count from MerkleTreeHook contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })
            .map(|res| res.value)
    }

    async fn latest_checkpoint(&self, _reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint> {
        self.contract
            .methods()
            .latest_checkpoint()
            .simulate(Execution::StateReadOnly)
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to fetch latest checkpoint from MerkleTreeHook contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })
            .map(|res| {
                let (root, count) = res.value;
                Checkpoint {
                    root: root.into_h256(),
                    index: count,
                    merkle_tree_hook_address: self.address(),
                    mailbox_domain: self.domain.id(),
                }
            })
    }
}

// ----------------------------------------------------------
// ---------------------- Indexer ---------------------------
// ----------------------------------------------------------

/// Struct that retrieves event data for a Fuel MerkleTreeHook contract
#[derive(Debug)]
pub struct FuelMerkleTreeHookIndexer {
    indexer: FuelIndexer<InsertedIntoTreeEvent>,
    contract: MerkleTreeHookContract<WalletUnlocked>,
}

impl FuelMerkleTreeHookIndexer {
    /// Create a new fuel MerkleTreeHook indexer
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let contract = MerkleTreeHookContract::new(
            Bech32ContractId::from_h256(&locator.address),
            wallet.clone(),
        );
        let indexer = FuelIndexer::new(conf, locator, wallet).await;

        Ok(Self { indexer, contract })
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for FuelMerkleTreeHookIndexer {
    /// Fetch list of logs between `range` of blocks
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        self.indexer.index_logs_in_range(range).await
    }

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.provider().get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for FuelMerkleTreeHookIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        self.contract
            .methods()
            .count_and_block()
            .simulate(Execution::StateReadOnly)
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to fetch count and block from MerkleTreeHook contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })
            .map(|res| {
                let (count, tip) = res.value;
                (Some(count), tip)
            })
    }
}
