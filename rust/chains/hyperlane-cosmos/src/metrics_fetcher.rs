use async_trait::async_trait;
use hyperlane_core::{
    metrics::agent::AgenMetricsFetcher, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, U256,
};

use crate::{address::CosmosAddress, ConnectionConf, CosmosProvider};

#[derive(Debug)]
pub struct CosmosMetricsFetcher {
    address: CosmosAddress,
    provider: CosmosProvider,
    domain: HyperlaneDomain,
}

impl CosmosMetricsFetcher {
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        address: CosmosAddress,
    ) -> ChainResult<Self> {
        let provider = CosmosProvider::new(
            locator.domain.clone(),
            conf.clone(),
            Some(locator.clone()),
            None,
        )?;

        Ok(Self {
            address,
            provider,
            domain: locator.domain.clone(),
        })
    }
}

impl HyperlaneChain for CosmosMetricsFetcher {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl AgenMetricsFetcher for CosmosMetricsFetcher {
    async fn get_balance(&self) -> ChainResult<U256> {
        self.provider.get_balance(self.address.address()).await
    }
}
