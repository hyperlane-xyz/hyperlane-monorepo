use crate::{
    indexer::SovIndexer,
    rest_client::{to_bech32, SovereignRestClient, TxEvent},
    ConnectionConf, Signer, SovereignProvider,
};
use async_trait::async_trait;
use core::ops::RangeInclusive;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult, Checkpoint,
    ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider,
    Indexed, Indexer, LogMeta, MerkleTreeHook, MerkleTreeInsertion, ReorgPeriod,
    SequenceAwareIndexer, H256, H512,
};
use serde::Deserialize;
use std::str::FromStr;

/// Struct that retrieves event data for a Sovereign Mailbox contract.
#[derive(Debug, Clone)]
pub struct SovereignMerkleTreeHookIndexer {
    provider: Box<SovereignProvider>,
    bech32_address: String,
}

impl SovereignMerkleTreeHookIndexer {
    pub async fn new(
        conf: ConnectionConf,
        locator: ContractLocator<'_>,
        _signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider = SovereignProvider::new(locator.domain.clone(), &conf, None).await?;
        Ok(SovereignMerkleTreeHookIndexer {
            provider: Box::new(provider),
            bech32_address: to_bech32(locator.address)?,
        })
    }
}

#[async_trait]
impl crate::indexer::SovIndexer<MerkleTreeInsertion> for SovereignMerkleTreeHookIndexer {
    const EVENT_KEY: &'static str = "Merkle/InsertedIntoTree";

    fn client(&self) -> &SovereignRestClient {
        self.provider.client()
    }

    async fn latest_sequence(&self) -> ChainResult<Option<u32>> {
        let sequence = self.client().tree(&self.bech32_address, None).await?;

        match u32::try_from(sequence.count) {
            Ok(x) => Ok(Some(x)),
            Err(e) => Err(ChainCommunicationError::CustomError(format!(
                "Tree count error: {e:?}"
            ))),
        }
    }
    fn decode_event(&self, event: &TxEvent) -> ChainResult<MerkleTreeInsertion> {
        let parsed_event: InsertedIntoTreeEvent = serde_json::from_value(event.value.clone())?;

        let merkle_insertion = MerkleTreeInsertion::new(
            parsed_event
                .inserted_into_tree
                .as_ref()
                .and_then(|d| d.index)
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(String::from(
                        "parsed_event contained None",
                    ))
                })?,
            H256::from_str(
                &parsed_event
                    .inserted_into_tree
                    .and_then(|d| d.id)
                    .ok_or_else(|| {
                        ChainCommunicationError::CustomError(String::from(
                            "parsed_event contained None",
                        ))
                    })?,
            )?,
        );

        Ok(merkle_insertion)
    }
}

#[derive(Clone, Debug, Deserialize)]
struct InsertedIntoTreeEvent {
    inserted_into_tree: Option<TreeEventBody>,
}

#[derive(Clone, Debug, Deserialize)]
struct TreeEventBody {
    id: Option<String>,
    index: Option<u32>,
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for SovereignMerkleTreeHookIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        <Self as SovIndexer<MerkleTreeInsertion>>::latest_sequence_count_and_tip(self).await
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for SovereignMerkleTreeHookIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        <Self as SovIndexer<MerkleTreeInsertion>>::fetch_logs_in_range(self, range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        <Self as SovIndexer<MerkleTreeInsertion>>::get_finalized_block_number(self).await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        <Self as SovIndexer<MerkleTreeInsertion>>::fetch_logs_by_tx_hash(self, tx_hash).await
    }
}

/// A struct for the Merkle Tree Hook on the Sovereign chain
#[derive(Debug)]
pub struct SovereignMerkleTreeHook {
    domain: HyperlaneDomain,
    address: H256,
    provider: SovereignProvider,
}

impl SovereignMerkleTreeHook {
    /// Create a new `SovereignMerkleTreeHook`.
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider =
            SovereignProvider::new(locator.domain.clone(), &conf.clone(), signer).await?;
        Ok(SovereignMerkleTreeHook {
            domain: locator.domain.clone(),
            provider,
            address: locator.address,
        })
    }
}

impl HyperlaneChain for SovereignMerkleTreeHook {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for SovereignMerkleTreeHook {
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl MerkleTreeHook for SovereignMerkleTreeHook {
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkle> {
        let lag = Some(reorg_period.as_blocks()?);
        let hook_id = to_bech32(self.address)?;
        let tree = self.provider.client().tree(&hook_id, lag).await?;

        Ok(tree)
    }

    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let lag = Some(reorg_period.as_blocks()?);
        let hook_id = to_bech32(self.address)?;
        let tree = self.provider.client().tree(&hook_id, lag).await?;

        match u32::try_from(tree.count) {
            Ok(x) => Ok(x),
            Err(e) => Err(ChainCommunicationError::CustomError(format!(
                "Tree count error: {e:?}"
            ))),
        }
    }

    async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint> {
        let lag = Some(reorg_period.as_blocks()?);
        let hook_id = to_bech32(self.address)?;
        let checkpoint = self
            .provider
            .client()
            .latest_checkpoint(&hook_id, lag, self.domain.id())
            .await?;

        Ok(checkpoint)
    }
}
