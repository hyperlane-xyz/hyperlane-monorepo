//! Chain-neutral events and the source interface used by the indexing worker.
use async_trait::async_trait;
use ethers::types::H256 as EthersH256;
use eyre::{ensure, Result};
use hyperlane_core::{HyperlaneMessage, H256, H512};

mod evm;
mod generic;
pub(super) use evm::{EvmContracts, SourceBuilder};
pub(super) use generic::GenericSource;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Header {
    pub height: u64,
    pub timestamp: u64,
    pub hash: EthersH256,
    /// Zero when the protocol provider does not expose parent hashes.
    pub parent: EthersH256,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Event {
    pub block_number: u64,
    pub block_hash: EthersH256,
    pub address: H256,
    pub tx_hash: Option<H512>,
    pub tx_index: u64,
    pub log_index: u64,
    pub sequence: Option<u32>,
    pub data: EventData,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum EventData {
    Dispatch(HyperlaneMessage),
    Delivery(H256),
    Insertion {
        message_id: H256,
        index: u32,
    },
    Gas {
        message_id: H256,
        destination: u32,
        gas: String,
        payment: String,
    },
}

pub(super) struct EventBatch {
    pub events: Vec<Event>,
    pub through: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Contracts {
    pub mailbox: H256,
    pub hook: H256,
    pub paymaster: H256,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum BlockSelector {
    Height(u64),
    Latest,
    Safe,
    Finalized,
}

impl From<u64> for BlockSelector {
    fn from(height: u64) -> Self {
        Self::Height(height)
    }
}

#[async_trait]
pub(super) trait Source: Send + Sync {
    async fn begin_cycle(&self) {}
    async fn header(&self, block: BlockSelector) -> Result<Header>;
    async fn fresh_header(&self, block: BlockSelector) -> Result<Header> {
        self.header(block).await
    }
    async fn range_end(&self, after: u64, through: u64, _head: u64) -> Result<Header> {
        ensure!(after < through, "Empty indexing range");
        self.header(BlockSelector::Height(through)).await
    }
    async fn fresh_range_end(&self, after: u64, through: u64, head: u64) -> Result<Header> {
        self.range_end(after, through, head).await
    }
    async fn events(&self, from: u64, through: u64) -> Result<Vec<Event>>;
    async fn events_after(
        &self,
        from: u64,
        through: u64,
        _sequences: [u32; 4],
    ) -> Result<EventBatch> {
        Ok(EventBatch {
            events: self.events(from, through).await?,
            through,
        })
    }
    /// Dispatch nonce and Merkle count pinned to the range boundary fork.
    async fn counts(&self, _hash: EthersH256) -> Result<Option<[u32; 2]>> {
        Ok(None)
    }
    /// Whether `counts` serves hash-pinned historical counts.
    fn has_historical_counts(&self) -> bool {
        false
    }
    fn indexes_by_sequence(&self) -> bool {
        false
    }
    /// Highest block for which every event stream can return a complete range.
    async fn indexing_tip(&self) -> Result<Option<u64>> {
        Ok(None)
    }
    /// Whether a sequence-indexed source has events after the durable cursors.
    async fn has_events_after(&self, _sequences: [u32; 4]) -> Result<Option<bool>> {
        Ok(None)
    }
    /// Latest counts that a block-indexed source must reach before publication.
    /// `None` streams do not expose a count and retain their existing guarantees.
    async fn tip_sequence_counts(&self) -> Result<Option<[(Option<u32>, u32); 4]>> {
        Ok(None)
    }
    async fn empty_anchor(&self) -> Result<Option<Header>> {
        Ok(None)
    }
}
