use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::num::NonZeroU64;

use async_trait::async_trait;

use crate::{make_provider, ConnectionConf};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, HyperlaneAbi, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, Indexer, LogMeta, Mailbox,
    MailboxIndexer, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::contracts::mailbox::Mailbox as FuelMailboxInner;
use crate::conversions::*;

/// A reference to a Mailbox contract on some Fuel chain
pub struct FuelMailbox {
    contract: FuelMailboxInner,
    domain: HyperlaneDomain,
}

impl FuelMailbox {
    /// Create a new fuel mailbox
    pub fn new(conf: &ConnectionConf) -> ChainResult<Self> {
        let provider = make_provider(conf);
        // FuelMailboxInner::new()
        todo!()
    }
}

impl HyperlaneContract for FuelMailbox {
    fn address(&self) -> H256 {
        self.contract.get_contract_id().into_h256()
    }
}

impl HyperlaneChain for FuelMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }
}

impl Debug for FuelMailbox {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self as &dyn HyperlaneContract)
    }
}

#[async_trait]
impl Mailbox for FuelMailbox {
    async fn count(&self) -> ChainResult<u32> {
        self.contract
            .methods()
            .count()
            .simulate()
            .await
            .map(|r| r.value)
            .map_err(ChainCommunicationError::from_other)
    }

    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        todo!()
    }

    async fn latest_checkpoint(&self, _lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        // TODO: does fuel even support querying at a given block number?
        let (root, index) = self
            .contract
            .methods()
            .latest_checkpoint()
            .simulate()
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value;

        Ok(Checkpoint {
            mailbox_address: self.address(),
            mailbox_domain: self.domain.id(),
            root: root.into_h256(),
            index,
        })
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

struct FuelMailboxAbi;

impl HyperlaneAbi for FuelMailboxAbi {
    const SELECTOR_SIZE_BYTES: usize = 8;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        // Can't support this without Fuels exporting it in the generated code
        todo!()
    }
}
