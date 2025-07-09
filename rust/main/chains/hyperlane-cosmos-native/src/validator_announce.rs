use async_trait::async_trait;
use cosmrs::Any;
use hex::ToHex;
use hyperlane_cosmos_rs::hyperlane::core::interchain_security::v1::MsgAnnounceValidator;
use hyperlane_cosmos_rs::prost::{Message, Name};

use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, Encode, FixedPointNumber, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome,
    ValidatorAnnounce, H160, H256, U256,
};

use crate::CosmosNativeProvider;

/// A reference to a ValidatorAnnounce contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosNativeValidatorAnnounce {
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosNativeProvider,
}

impl CosmosNativeValidatorAnnounce {
    /// create a new instance of CosmosValidatorAnnounce
    pub fn new(provider: CosmosNativeProvider, locator: ContractLocator) -> ChainResult<Self> {
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
                .grpc()
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
        let signer = self.provider.rpc().get_signer()?.address_string.to_owned();
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

        // we assume that the underlying cosmos chain does not have gas refunds
        // in that case the gas paid will always be:
        // gas_wanted * gas_price
        let gas_price =
            FixedPointNumber::from(response.tx_result.gas_wanted) * self.provider.rpc().gas_price();

        Ok(TxOutcome {
            transaction_id: H256::from_slice(response.hash.as_bytes()).into(),
            executed: response.check_tx.code.is_ok() && response.tx_result.code.is_ok(),
            gas_used: response.tx_result.gas_used.into(),
            gas_price,
        })
    }

    async fn announce_tokens_needed(
        &self,
        _announcement: SignedType<Announcement>,
        _chain_signer: H256,
    ) -> Option<U256> {
        // TODO: check user balance. For now, just try announcing and
        // allow the announce attempt to fail if there are not enough tokens.
        Some(0u64.into())
    }
}
