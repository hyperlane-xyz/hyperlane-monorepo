use async_trait::async_trait;
use cosmrs::Any;
use hex::ToHex;
use hyperlane_cosmos_rs::hyperlane::core::interchain_security::v1::MsgAnnounceValidator;
use hyperlane_cosmos_rs::prost::{Message, Name};

use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, Encode, FixedPointNumber, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome,
    ValidatorAnnounce, H160, H256, U256, H512,
};

use crate::KaspaProvider;

/// A reference to a ValidatorAnnounce contract on some Kaspa chain
#[derive(Debug)]
pub struct KaspaValidatorAnnounce {
    domain: HyperlaneDomain,
    address: H256,
    provider: KaspaProvider,
}

impl KaspaValidatorAnnounce {
    /// create a new instance of KaspaValidatorAnnounce
    pub fn new(provider: KaspaProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
    }
}

impl HyperlaneContract for KaspaValidatorAnnounce {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for KaspaValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl ValidatorAnnounce for KaspaValidatorAnnounce {

    // called by validator to check he announced before he starts
    // needs to return the location for the calling validator at least
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        // TODO: can arguably return the server URL here
        Ok(vec![])
    }

    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        Ok(TxOutcome {
            transaction_id: H512::from_slice(b"0x0000000000000000000000000000000000000000000000000000000000000000"),
            executed: true, 
            gas_used: 0.into(),
            gas_price: 0.into(),
        })
    }

    async fn announce_tokens_needed(
        &self,
        _announcement: SignedType<Announcement>,
        _chain_signer: H256,
    ) -> Option<U256> {
        Some(0u64.into())
    }
}
