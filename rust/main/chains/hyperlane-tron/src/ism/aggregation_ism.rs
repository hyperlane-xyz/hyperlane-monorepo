#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::sync::Arc;

use async_trait::async_trait;
use tracing::instrument;

use hyperlane_core::{
    AggregationIsm, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, RawHyperlaneMessage, H256,
};

use crate::{
    interfaces::i_aggregation_ism::IAggregationIsm as EthereumAggregationIsmInternal, TronProvider,
};

/// A reference to an AggregationIsm contract on some Ethereum chain
#[derive(Debug)]
pub struct TronAggregationIsm {
    contract: Arc<EthereumAggregationIsmInternal<TronProvider>>,
    domain: HyperlaneDomain,
}

impl TronAggregationIsm {
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        let provider = Arc::new(provider);
        Self {
            contract: Arc::new(EthereumAggregationIsmInternal::new(
                locator.address,
                provider,
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneChain for TronAggregationIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.contract.client().clone())
    }
}

impl HyperlaneContract for TronAggregationIsm {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl AggregationIsm for TronAggregationIsm {
    #[instrument(err, skip(self, message))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn modules_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let (isms, threshold) = self
            .contract
            .modules_and_threshold(RawHyperlaneMessage::from(message).to_vec().into())
            .call()
            .await?;
        let isms_h256 = isms.iter().map(|address| (*address).into()).collect();
        Ok((isms_h256, threshold))
    }
}
