use async_trait::async_trait;
use radix_common::manifest_args;
use scrypto::data::manifest::ManifestArgs;
use scrypto::types::ComponentAddress;

use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H256, U256,
};

use crate::{
    address_from_h256, encode_component_address, ConnectionConf, EthAddress, RadixProvider,
};

/// Radix Validator Announce
#[derive(Debug)]
pub struct RadixValidatorAnnounce {
    provider: RadixProvider,
    encoded_address: String,
    address: ComponentAddress,
    address_256: H256,
}

impl RadixValidatorAnnounce {
    /// New validator announce instance
    pub fn new(
        provider: RadixProvider,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> ChainResult<Self> {
        let encoded_address = encode_component_address(&conf.network, locator.address)?;
        let address = address_from_h256(locator.address);
        Ok(Self {
            address,
            encoded_address,
            provider,
            address_256: locator.address,
        })
    }
}

impl HyperlaneContract for RadixValidatorAnnounce {
    fn address(&self) -> H256 {
        self.address_256
    }
}

impl HyperlaneChain for RadixValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl ValidatorAnnounce for RadixValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let eth_addresses: Vec<EthAddress> = validators.iter().map(EthAddress::from).collect();
        let storage_locations: Vec<Vec<String>> = self
            .provider
            .call_method_with_arg(
                &self.encoded_address,
                "get_announced_storage_locations",
                &eth_addresses,
            )
            .await?;

        Ok(storage_locations)
    }

    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let address: EthAddress = announcement.value.validator.into();
        let location = announcement.value.storage_location;
        let signature = announcement.signature.to_vec();
        self.provider
            .send_tx(
                |builder| {
                    builder.call_method(
                        self.address,
                        "announce",
                        manifest_args!(address, &location, &signature),
                    )
                },
                None,
            )
            .await
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

    async fn announce_calldata(
        &self,
        _announcement: SignedType<Announcement>,
    ) -> ChainResult<Vec<u8>> {
        Err(hyperlane_core::ChainCommunicationError::CustomError(
            "announce_calldata not supported for Radix".to_string(),
        ))
    }
}
