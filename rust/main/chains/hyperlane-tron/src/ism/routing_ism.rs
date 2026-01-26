#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::sync::Arc;

use async_trait::async_trait;
use tracing::instrument;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RawHyperlaneMessage, RoutingIsm, H256,
};

use crate::interfaces::i_routing_ism::IRoutingIsm as TronRoutingIsmInternal;
use crate::TronProvider;

/// A reference to an RoutingIsm contract on some Tron chain
#[derive(Debug)]
pub struct TronRoutingIsm {
    contract: Arc<TronRoutingIsmInternal<TronProvider>>,
    domain: HyperlaneDomain,
}

impl TronRoutingIsm {
    /// Creates a new TronRoutingIsm instance
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(TronRoutingIsmInternal::new(
                locator.address,
                Arc::new(provider),
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneChain for TronRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.contract.client().clone())
    }
}

impl HyperlaneContract for TronRoutingIsm {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl RoutingIsm for TronRoutingIsm {
    #[instrument(err, skip(self, message))]
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        let ism = self
            .contract
            .route(RawHyperlaneMessage::from(message).to_vec().into())
            .call()
            .await?;
        Ok(ism.into())
    }
}
