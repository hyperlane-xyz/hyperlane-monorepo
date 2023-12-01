use std::str::FromStr;

use crate::{
    address::CosmosAddress,
    grpc::WasmProvider,
    payloads::aggregate_ism::{ModulesAndThresholdRequest, ModulesAndThresholdResponse},
    ConnectionConf, CosmosProvider, Signer,
};
use async_trait::async_trait;
use hyperlane_core::{
    AggregationIsm, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, H256,
};
use tracing::instrument;

/// A reference to an AggregationIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosAggregationIsm {
    domain: HyperlaneDomain,
    address: H256,
    provider: Box<CosmosProvider>,
}

impl CosmosAggregationIsm {
    /// create new Cosmos AggregationIsm agent
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider = CosmosProvider::new(
            locator.domain.clone(),
            conf.clone(),
            Some(locator.clone()),
            signer,
        )?;

        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider: Box::new(provider),
        })
    }
}

impl HyperlaneContract for CosmosAggregationIsm {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosAggregationIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.clone()
    }
}

#[async_trait]
impl AggregationIsm for CosmosAggregationIsm {
    #[instrument(err)]
    async fn modules_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let payload = ModulesAndThresholdRequest::new(message);

        let data = self.provider.grpc().wasm_query(payload, None).await?;
        let response: ModulesAndThresholdResponse = serde_json::from_slice(&data)?;

        let modules: ChainResult<Vec<H256>> = response
            .modules
            .into_iter()
            .map(|module| CosmosAddress::from_str(&module).map(|ca| ca.digest()))
            .collect();

        Ok((modules?, response.threshold))
    }
}
