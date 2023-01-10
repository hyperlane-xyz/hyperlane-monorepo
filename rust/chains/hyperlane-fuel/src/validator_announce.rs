use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    ValidatorAnnounce, H256,
};

/// A reference to a ValidatorAnnounce contract on some Fuel chain
#[derive(Debug)]
pub struct FuelValidatorAnnounce {}

impl HyperlaneContract for FuelValidatorAnnounce {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for FuelValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }
}

#[async_trait]
impl ValidatorAnnounce for FuelValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: Vec<H256>,
    ) -> ChainResult<Vec<Vec<String>>> {
        todo!()
    }
}
