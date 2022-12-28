use std::fmt::Debug;

use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, Checkpoint, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    Indexer, LogMeta, Mailbox, MailboxIndexer, TxCostEstimate, TxOutcome, H256, U256,
};

/// A reference to a Mailbox contract on some Fuel chain
#[derive(Debug)]
pub struct FuelMailbox {}

impl HyperlaneContract for FuelMailbox {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for FuelMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }
}

#[async_trait]
impl Mailbox for FuelMailbox {
    async fn count(&self) -> ChainResult<u32> {
        todo!()
    }

    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        todo!()
    }

    async fn latest_checkpoint(&self, lag: Option<u64>) -> ChainResult<Checkpoint> {
        todo!()
    }

    async fn default_ism(&self) -> ChainResult<H256> {
        todo!()
    }

    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        todo!()
    }

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

/// Struct that retrieves event data for a Fuel Mailbox contract
#[derive(Debug)]
pub struct FuelMailboxIndexer {}

#[async_trait]
impl Indexer for FuelMailboxIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        todo!()
    }
}

#[async_trait]
impl MailboxIndexer for FuelMailboxIndexer {
    async fn fetch_sorted_messages(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {
        todo!()
    }

    async fn fetch_delivered_messages(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(H256, LogMeta)>> {
        todo!()
    }
}
