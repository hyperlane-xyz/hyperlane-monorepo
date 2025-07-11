#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;
use hyperlane_core::{
    AggregationIsm, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, H256,
};
use starknet::core::types::Felt;
use tracing::instrument;

use crate::contracts::aggregation_ism::{AggregationIsmReader, Message as StarknetMessage};
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{build_json_provider, ConnectionConf, JsonProvider, StarknetProvider};

/// A reference to a AggregationISM contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetAggregationIsm {
    contract: AggregationIsmReader<JsonProvider>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetAggregationIsm {
    /// Create a reference to a AggregationISM at a specific Starknet address on some
    /// chain
    pub fn new(conn: &ConnectionConf, locator: &ContractLocator<'_>) -> ChainResult<Self> {
        let provider = build_json_provider(conn);
        let ism_address: Felt = HyH256(locator.address).into();
        let contract = AggregationIsmReader::new(ism_address, provider);

        Ok(Self {
            contract,
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }
}

impl HyperlaneChain for StarknetAggregationIsm {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetAggregationIsm {
    fn address(&self) -> H256 {
        HyH256::from(self.contract.address).0
    }
}

#[async_trait]
impl AggregationIsm for StarknetAggregationIsm {
    #[instrument(err)]
    async fn modules_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let message: StarknetMessage = message.into();

        let (isms, threshold) = self
            .contract
            .modules_and_threshold(&message)
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        let isms_h256 = isms
            .iter()
            .map(|address| HyH256::from(address.0).0)
            .collect();

        Ok((isms_h256, threshold))
    }
}
