use async_trait::async_trait;

use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};

use crate::cw::payloads::validator_announce::{
    AnnouncementRequest, AnnouncementRequestInner, GetAnnounceStorageLocationsRequest,
    GetAnnounceStorageLocationsRequestInner, GetAnnounceStorageLocationsResponse,
};
use crate::{utils, CosmosProvider};

use super::CwQueryClient;

/// A reference to a ValidatorAnnounce contract on some Cosmos chain
#[derive(Debug)]
pub struct CwValidatorAnnounce {
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosProvider<CwQueryClient>,
}

impl CwValidatorAnnounce {
    /// create a new instance of CosmosValidatorAnnounce
    pub fn new(
        provider: CosmosProvider<CwQueryClient>,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
    }
}

impl HyperlaneContract for CwValidatorAnnounce {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CwValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl ValidatorAnnounce for CwValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let vss = validators
            .iter()
            .map(|v| H160::from(*v))
            .map(|v| hex::encode(v.as_bytes()))
            .collect::<Vec<String>>();

        let payload = GetAnnounceStorageLocationsRequest {
            get_announce_storage_locations: GetAnnounceStorageLocationsRequestInner {
                validators: vss,
            },
        };

        let data: Vec<u8> = self.provider.query().wasm_query(payload, None).await?;
        let response: GetAnnounceStorageLocationsResponse = serde_json::from_slice(&data)?;

        Ok(response
            .storage_locations
            .into_iter()
            .map(|v| v.1)
            .collect())
    }

    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let announce_request = AnnouncementRequest {
            announce: AnnouncementRequestInner {
                validator: hex::encode(announcement.value.validator),
                storage_location: announcement.value.storage_location,
                signature: hex::encode(announcement.signature.to_vec()),
            },
        };
        let payload = self.provider.query().wasm_encode_msg(announce_request)?;

        let response = self.provider.rpc().send(vec![payload], None).await?;
        Ok(utils::tx_response_to_outcome(
            response,
            self.provider.rpc().gas_price(),
        ))
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
        let announce_request = AnnouncementRequest {
            announce: AnnouncementRequestInner {
                validator: hex::encode(announcement.value.validator),
                storage_location: announcement.value.storage_location,
                signature: hex::encode(announcement.signature.to_vec()),
            },
        };
        serde_json::to_vec(&announce_request).map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::{Announcement, Signature, SignedType, H256, U256};

    use super::{AnnouncementRequest, AnnouncementRequestInner};

    fn create_test_signed_announcement() -> SignedType<Announcement> {
        let announcement = Announcement {
            validator: H256::from_low_u64_be(1).into(),
            mailbox_address: H256::from_low_u64_be(2),
            mailbox_domain: 1,
            storage_location: "s3://test-bucket/validator".to_string(),
        };

        // Create a mock signature
        let signature = Signature {
            r: U256::from(1),
            s: U256::from(2),
            v: 27,
        };

        SignedType {
            value: announcement,
            signature,
        }
    }

    #[test]
    fn test_announce_calldata_structure() {
        let signed_announcement = create_test_signed_announcement();

        let announce_request = AnnouncementRequest {
            announce: AnnouncementRequestInner {
                validator: hex::encode(signed_announcement.value.validator),
                storage_location: signed_announcement.value.storage_location.clone(),
                signature: hex::encode(signed_announcement.signature.to_vec()),
            },
        };

        let calldata = serde_json::to_vec(&announce_request).expect("Failed to serialize");

        // Verify calldata can be deserialized back
        let parsed: AnnouncementRequest =
            serde_json::from_slice(&calldata).expect("Failed to deserialize");

        assert_eq!(
            parsed.announce.storage_location,
            "s3://test-bucket/validator"
        );
        assert!(!parsed.announce.validator.is_empty());
        assert!(!parsed.announce.signature.is_empty());
    }

    #[test]
    fn test_announce_calldata_json_format() {
        let signed_announcement = create_test_signed_announcement();

        let announce_request = AnnouncementRequest {
            announce: AnnouncementRequestInner {
                validator: hex::encode(signed_announcement.value.validator),
                storage_location: signed_announcement.value.storage_location.clone(),
                signature: hex::encode(signed_announcement.signature.to_vec()),
            },
        };

        let calldata = serde_json::to_vec(&announce_request).expect("Failed to serialize");

        // Verify JSON structure has expected format
        let json_value: serde_json::Value =
            serde_json::from_slice(&calldata).expect("Failed to parse JSON");

        assert!(json_value.is_object());
        assert!(json_value.get("announce").is_some());
        assert!(json_value["announce"]["validator"].is_string());
        assert!(json_value["announce"]["storage_location"].is_string());
        assert!(json_value["announce"]["signature"].is_string());
    }
}
