use std::hash::Hash;

use async_trait::async_trait;

use cosmrs::{proto::cosmos::base::abci::v1beta1::TxResponse, Any};
use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneProvider, Signable, SignedType, TxOutcome,
    ValidatorAnnounce, H160, H256, U256,
};
use prost::Message;

use crate::{
    signers::Signer, ConnectionConf, CosmosNativeProvider, HyperlaneCosmosError,
    MsgAnnounceValidator,
};

/// A reference to a ValidatorAnnounce contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosNativeValidatorAnnounce {
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosNativeProvider,
    signer: Option<Signer>,
}

impl CosmosNativeValidatorAnnounce {
    /// create a new instance of CosmosValidatorAnnounce
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider = CosmosNativeProvider::new(
            locator.domain.clone(),
            conf.clone(),
            locator.clone(),
            signer.clone(),
        )?;

        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
            signer,
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
        let mut validator_locations = vec![];
        for validator in validators {
            let locations = self
                .provider
                .rest()
                .validator_storage_locations(validator.clone())
                .await;
            if let Ok(locations) = locations {
                validator_locations.push(locations);
            } else {
                validator_locations.push(vec![])
            }
        }
        Ok(validator_locations)
    }

    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let signer = self
            .signer
            .as_ref()
            .map_or("".to_string(), |signer| signer.address.clone());
        let announce = MsgAnnounceValidator {
            validator: hex::encode(announcement.value.validator.as_bytes()),
            storage_location: announcement.value.storage_location.clone(),
            signature: hex::encode(announcement.signature.to_vec()),
            mailbox_id: hex::encode(announcement.value.mailbox_address.clone()),
            creator: signer,
        };

        let any_msg = Any {
            type_url: "/hyperlane.core.v1.MsgAnnounceValidator".to_string(),
            value: announce.encode_to_vec(),
        };

        let response = self.provider.rpc().send(vec![any_msg], None).await?;
        let tx = TxResponse::decode(response.data).map_err(HyperlaneCosmosError::from)?;
        Ok(TxOutcome {
            transaction_id: H256::from_slice(response.hash.as_bytes()).into(),
            executed: tx.code == 0,
            gas_used: tx.gas_used.into(),
            gas_price: U256::one().try_into()?,
        })
    }

    async fn announce_tokens_needed(&self, announcement: SignedType<Announcement>) -> Option<U256> {
        // TODO: check user balance. For now, just try announcing and
        // allow the announce attempt to fail if there are not enough tokens.
        Some(0u64.into())
    }
}
