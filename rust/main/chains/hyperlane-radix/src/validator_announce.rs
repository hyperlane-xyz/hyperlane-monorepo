use async_trait::async_trait;
use radix_common::manifest_args;
use scrypto::data::manifest::ManifestArgs;
use scrypto::prelude::manifest_encode;
use scrypto::types::ComponentAddress;

use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome,
    ValidatorAnnounce, H256, U256,
};

use crate::{
    address_from_h256, encode_component_address, ConnectionConf, EthAddress, HyperlaneRadixError,
    RadixProvider, RadixTxCalldata,
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
        announcement: SignedType<Announcement>,
    ) -> ChainResult<Vec<u8>> {
        let address: EthAddress = announcement.value.validator.into();
        let location = announcement.value.storage_location;
        let signature = announcement.signature.to_vec();

        let args = manifest_args!(address, &location, &signature);
        let encoded_arguments = manifest_encode(&args).map_err(HyperlaneRadixError::from)?;

        let data = RadixTxCalldata {
            component_address: self.encoded_address.clone(),
            method_name: "announce".into(),
            encoded_arguments,
        };

        serde_json::to_vec(&data).map_err(ChainCommunicationError::from_other)
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::{Announcement, H256};
    use radix_common::manifest_args;
    use scrypto::prelude::{manifest_encode, ManifestArgs};

    use crate::{EthAddress, RadixTxCalldata};

    const VA_ADDRESS: &str = "component_rdx1cpcq2wcs8zmpjanjf5ek76y4wttdxswnyfcuhynz4zmhjfjxqfsg9z";

    fn create_test_announcement() -> Announcement {
        Announcement {
            validator: H256::from_low_u64_be(1).into(),
            mailbox_address: H256::from_low_u64_be(2),
            mailbox_domain: 1,
            storage_location: "s3://test-bucket/validator".to_string(),
        }
    }

    /// Helper to build expected calldata for comparison
    fn build_expected_calldata(announcement: &Announcement) -> RadixTxCalldata {
        let address: EthAddress = announcement.validator.into();
        let location = &announcement.storage_location;
        let signature: Vec<u8> = vec![0u8; 65]; // Mock signature

        let args: ManifestArgs = manifest_args!(address, location, &signature);
        let encoded_arguments = manifest_encode(&args).expect("Failed to encode args");

        RadixTxCalldata {
            component_address: VA_ADDRESS.to_string(),
            method_name: "announce".into(),
            encoded_arguments,
        }
    }

    #[test]
    fn test_announce_calldata_structure() {
        // Test that the calldata has the expected structure
        let announcement = create_test_announcement();
        let expected = build_expected_calldata(&announcement);

        // Verify the expected structure is correct
        assert_eq!(expected.method_name, "announce");
        assert_eq!(expected.component_address, VA_ADDRESS);
        assert!(!expected.encoded_arguments.is_empty());

        // Verify it can be serialized to JSON
        let json = serde_json::to_vec(&expected).expect("Failed to serialize");
        let parsed: RadixTxCalldata = serde_json::from_slice(&json).expect("Failed to parse");
        assert_eq!(parsed, expected);
    }
}
