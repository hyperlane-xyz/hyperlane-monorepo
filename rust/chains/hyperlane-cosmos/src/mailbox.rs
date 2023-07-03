use std::fmt::{Debug, Formatter};
use std::num::NonZeroU64;

use async_trait::async_trait;
use tracing::instrument;

use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, utils::fmt_bytes, ChainResult, Checkpoint,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
    Indexer, LogMeta, Mailbox, TxCostEstimate, TxOutcome, H256, U256,
};

/// A reference to a Mailbox contract on some Cosmos chain
pub struct CosmosMailbox {}

impl HyperlaneContract for CosmosMailbox {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for CosmosMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

impl Debug for CosmosMailbox {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self as &dyn HyperlaneContract)
    }
}

#[async_trait]
impl Mailbox for CosmosMailbox {
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn count(&self, lag: Option<NonZeroU64>) -> ChainResult<u32> {
        todo!()
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn tree(&self, lag: Option<NonZeroU64>) -> ChainResult<IncrementalMerkle> {
        todo!()
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        todo!()
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        todo!()
    }

    #[instrument(err, ret, skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        todo!()
    }

    #[instrument(err, ret, skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        todo!()
    }

    #[instrument(err, ret, skip(self))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        todo!()
    }

    #[instrument(err, ret, skip(self), fields(msg=%message, metadata=%fmt_bytes(metadata)))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        todo!()
    }

    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8> {
        todo!()
    }
}

/// Struct that retrieves event data for a Cosmos Mailbox contract
#[derive(Debug)]
pub struct CosmosMailboxIndexer {}

#[async_trait]
impl Indexer<HyperlaneMessage> for CosmosMailboxIndexer {
    async fn fetch_logs(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {
        todo!()
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        todo!()
    }
}

#[async_trait]
impl Indexer<H256> for CosmosMailboxIndexer {
    async fn fetch_logs(&self, from: u32, to: u32) -> ChainResult<Vec<(H256, LogMeta)>> {
        todo!()
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        todo!()
    }
}
