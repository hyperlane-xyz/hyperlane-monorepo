use async_trait::async_trait;
use cosmrs::Any;
use hex::ToHex;
use hyperlane_cosmos_rs::hyperlane::core::interchain_security::v1::MsgAnnounceValidator;
use hyperlane_cosmos_rs::prost::{Message, Name};

use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, Encode, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};

use crate::{utils, CosmosProvider};

use super::module_query_client::ModuleQueryClient;

/// A reference to a ValidatorAnnounce contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosNativeValidatorAnnounce {
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosProvider<ModuleQueryClient>,
}

impl CosmosNativeValidatorAnnounce {
    /// create a new instance of CosmosValidatorAnnounce
    pub fn new(
        provider: CosmosProvider<ModuleQueryClient>,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
    }
}

impl HyperlaneContract for CosmosNativeValidatorAnnounce {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosNativeValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl ValidatorAnnounce for CosmosNativeValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let validators = validators
            .iter()
            .map(|v| H160::from(*v))
            .map(|v| v.encode_hex())
            .collect::<Vec<String>>();
        let mut validator_locations = vec![];
        for validator in validators {
            let locations = self
                .provider
                .query()
                .announced_storage_locations(self.address.encode_hex(), validator.clone())
                .await;
            if let Ok(locations) = locations {
                validator_locations.push(locations.storage_locations);
            } else {
                validator_locations.push(vec![])
            }
        }
        Ok(validator_locations)
    }

    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let signer = self.provider.rpc().get_signer()?.address.to_owned();
        let announce = MsgAnnounceValidator {
            validator: announcement.value.validator.encode_hex(),
            storage_location: announcement.value.storage_location.clone(),
            signature: hex::encode(announcement.signature.to_vec()),
            mailbox_id: "0x".to_owned() + &hex::encode(announcement.value.mailbox_address.to_vec()), // has to be prefixed with 0x
            creator: signer,
        };

        let any_msg = Any {
            type_url: MsgAnnounceValidator::type_url(),
            value: announce.encode_to_vec(),
        };

        let response = self.provider.rpc().send(vec![any_msg], None).await?;

        Ok(utils::tx_response_to_outcome(
            response,
            self.provider.rpc().gas_price(),
        ))
    }

    async fn announce_tokens_needed(
        &self,
        _announcement: SignedType<Announcement>,
    ) -> Option<U256> {
        // TODO: check user balance. For now, just try announcing and
        // allow the announce attempt to fail if there are not enough tokens.
        Some(0u64.into())
    }
}
