use async_trait::async_trait;

use hyperlane_core::{
    Announcement, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H256, U256,
};

/// A reference to a ValidatorAnnounce contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosValidatorAnnounce {}

impl HyperlaneContract for CosmosValidatorAnnounce {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for CosmosValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

#[async_trait]
impl ValidatorAnnounce for CosmosValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        todo!()
    }

    async fn announce(
        &self,
        announcement: SignedType<Announcement>,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        todo!()
    }

    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<U256> {
        todo!()
    }
}
