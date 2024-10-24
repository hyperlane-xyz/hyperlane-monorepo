use std::{num::NonZeroU64, ops::RangeInclusive};

use crate::{
    contracts::merkle_tree_hook::MerkleTreeHook as MerkleTreeHookContract, conversions::*,
    ConnectionConf, FuelIndexer, FuelProvider, TransactionEventType,
};
use async_trait::async_trait;
use fuels::{
    accounts::wallet::WalletUnlocked,
    tx::Receipt,
    types::{
        bech32::Bech32ContractId, transaction_response::TransactionResponse, tx_status::TxStatus,
        Bytes32,
    },
};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult, Checkpoint,
    ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider,
    Indexed, Indexer, LogMeta, MerkleTreeHook, MerkleTreeInsertion, SequenceAwareIndexer, H256,
    U256,
};

/// A reference to a AggregationIsm contract on some Fuel chain
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
    async fn tree(&self, lag: Option<NonZeroU64>) -> ChainResult<IncrementalMerkle> {
        assert!(
            lag.is_none(),
            "Fuel does not support querying point-in-time"
        );

        self.contract
            .methods()
            .tree()
            .call()
            .await
            .map_err(ChainCommunicationError::from_other)
            .map(|res| {
                let merkle_tree = res.value;
                IncrementalMerkle {
                    branch: merkle_tree.branch.into_h256_array(),
                    count: merkle_tree.count as usize,
                }
            })
    }

    async fn count(&self, lag: Option<NonZeroU64>) -> ChainResult<u32> {
        assert!(
            lag.is_none(),
            "Fuel does not support querying point-in-time"
        );

        self.contract
            .methods()
            .count()
            .call()
            .await
            .map_err(ChainCommunicationError::from_other)
            .map(|res| res.value)
    }

    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        assert!(
            lag.is_none(),
            "Fuel does not support querying point-in-time"
        );

        self.contract
            .methods()
            .latest_checkpoint()
            .call()
            .await
            .map_err(ChainCommunicationError::from_other)
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

const MESSAGE_ID_LEN: usize = 32;

/// Struct that retrieves event data for a Fuel MerkleTreeHook contract
#[derive(Debug)]
pub struct FuelMerkleTreeHookIndexer {
    indexer: FuelIndexer,
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
        let indexer = FuelIndexer::new(
            conf,
            locator,
            wallet,
            TransactionEventType::MerkleTreeHookInsert,
        )
        .await;

        Ok(Self { indexer, contract })
    }

    /// Parses merkle tree hook post dispatch transactions into the appropriate data to generate indexed logs
    pub fn merkle_tree_hook_parser(
        transactions: Vec<(Bytes32, TransactionResponse)>,
    ) -> Vec<(Bytes32, TransactionResponse, MerkleTreeInsertion, U256)> {
        transactions
            .into_iter()
            .filter_map(|(tx_id, tx_data)| {
                let receipts = match &tx_data.status {
                    TxStatus::Success { receipts } => receipts,
                    _ => return None,
                };

                let (log_index, receipt_log_data) = receipts
                    .into_iter()
                    .enumerate()
                    .filter_map(|(log_index, rec)| match rec {
                        Receipt::LogData { .. } if rec.data().is_some() => {
                            let data = rec.data().map(|data| data.to_owned());

                            match data {
                                Some(data) => Some((U256::from(log_index), data)),
                                _ => None,
                            }
                        }
                        _ => None,
                    })
                    .next()?; // Each merkle tree hook post dispatch call should have only one logdata receipt

                if !receipt_log_data.is_empty() {
                    // The log is strucutred to have a message id first and the leaf index following it
                    let (id, index) = receipt_log_data.split_at(MESSAGE_ID_LEN);
                    let message_id =
                        H256::from(<[u8; 32]>::try_from(id).expect("slice with incorrect length"));
                    let leaf_index =
                        u32::from_be_bytes(index.try_into().expect("slice with incorrect length"));

                    let insertion = MerkleTreeInsertion::new(leaf_index, message_id);

                    Some((tx_id, tx_data, insertion, log_index))
                } else {
                    None
                }
            })
            .collect::<Vec<(Bytes32, TransactionResponse, MerkleTreeInsertion, U256)>>()
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for FuelMerkleTreeHookIndexer {
    /// Fetch list of logs between `range` of blocks
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        self.indexer
            .index_logs_in_range(range, Self::merkle_tree_hook_parser)
            .await
    }

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.provider().get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for FuelMerkleTreeHookIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        self.contract
            .methods()
            .count()
            .call()
            .await
            .map_err(ChainCommunicationError::from_other)
            .map(|res| (Some(res.value), tip))
    }
}
