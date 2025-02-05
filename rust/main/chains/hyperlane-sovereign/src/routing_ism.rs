use crate::{ConnectionConf, Signer, SovereignProvider};
use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RoutingIsm, H256,
};

/// A struct for the Routing ISM on the Sovereign chain.
#[derive(Debug)]
pub struct SovereignRoutingIsm {
    domain: HyperlaneDomain,
    address: H256,
    provider: SovereignProvider,
}

impl SovereignRoutingIsm {
    /// Create a new `SovereignRoutingIsm`.
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider = SovereignProvider::new(locator.domain.clone(), &conf.clone(), signer).await;
        Ok(SovereignRoutingIsm {
            domain: locator.domain.clone(),
            provider,
            address: locator.address,
        })
    }
}

impl HyperlaneContract for SovereignRoutingIsm {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for SovereignRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl RoutingIsm for SovereignRoutingIsm {
    async fn route(&self, _message: &HyperlaneMessage) -> ChainResult<H256> {
        // let result = self.provider.client().route().await?;
        // Ok(result)
        todo!("Not yet implemented")
    }
}
