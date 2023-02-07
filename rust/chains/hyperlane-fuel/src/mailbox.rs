use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::num::NonZeroU64;

use async_trait::async_trait;
use fuels::prelude::{Bech32ContractId, WalletUnlocked};
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, ContractLocator, HyperlaneAbi,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
    Indexer, LogMeta, Mailbox, MailboxIndexer, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::{
    contracts::mailbox::Mailbox as FuelMailboxInner, conversions::*, make_provider, ConnectionConf,
};

/// A reference to a Mailbox contract on some Fuel chain
pub struct FuelMailbox {
    contract: FuelMailboxInner,
    domain: HyperlaneDomain,
}

impl FuelMailbox {
    /// Create a new fuel mailbox
    pub fn new(
        conf: &ConnectionConf,
        locator: ContractLocator,
        mut wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let provider = make_provider(conf)?;
        wallet.set_provider(provider);
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelMailbox {
            contract: FuelMailboxInner::new(address, wallet),
            domain: locator.domain,
        })
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

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

impl Debug for FuelMailbox {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self as &dyn HyperlaneContract)
    }
}

#[async_trait]
impl Mailbox for FuelMailbox {
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn count(&self) -> ChainResult<u32> {
        self.contract
            .methods()
            .count()
            .simulate()
            .await
            .map(|r| r.value)
            .map_err(ChainCommunicationError::from_other)
    }

    #[instrument(err, ret, skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        todo!()
    }

    #[instrument(err, ret, skip(self))]
    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        assert!(
            lag.is_none(),
            "Fuel does not support querying point-in-time"
        );
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

    #[instrument(err, ret, skip(self))]
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
