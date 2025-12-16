#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RoutingIsm, H256,
};
use starknet::core::types::Felt;
use tracing::instrument;

use crate::contracts::routing_ism::RoutingIsmReader;
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{ConnectionConf, JsonProvider, StarknetProvider};

/// A reference to a RoutingISM contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetRoutingIsm {
    contract: RoutingIsmReader<JsonProvider>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetRoutingIsm {
    /// Create a reference to a RoutingISM at a specific Starknet address on some
    pub fn new(
        provider: StarknetProvider,
        conn: &ConnectionConf,
        locator: &ContractLocator<'_>,
    ) -> ChainResult<Self> {
        let json_provider = provider.rpc_client().clone();
        let ism_address: Felt = HyH256(locator.address).into();
        let contract = RoutingIsmReader::new(ism_address, json_provider);

        Ok(Self {
            contract,
            provider,
            conn: conn.clone(),
        })
    }
}

impl HyperlaneChain for StarknetRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetRoutingIsm {
    fn address(&self) -> H256 {
        HyH256::from(self.contract.address).0
    }
}

#[async_trait]
impl RoutingIsm for StarknetRoutingIsm {
    #[instrument(err)]
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        let message = &message.into();

        let ism = self
            .contract
            .route(message)
            .block_id(starknet::core::types::BlockId::Tag(
                starknet::core::types::BlockTag::Latest,
            ))
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok(HyH256::from(ism.0).0)
    }
}
