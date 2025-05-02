use async_trait::async_trait;

use cosmrs::proto::cosmos::base::abci::v1beta1::TxResponse;
use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};

use crate::{
    grpc::WasmProvider,
    payloads::validator_announce::{
        self, AnnouncementRequest, AnnouncementRequestInner, GetAnnounceStorageLocationsRequest,
        GetAnnounceStorageLocationsRequestInner,
    },
    signers::Signer,
    types::tx_response_to_outcome,
    ConnectionConf, CosmosProvider,
};

/// A reference to a ValidatorAnnounce contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosValidatorAnnounce {
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosProvider,
}

impl CosmosValidatorAnnounce {
    /// create a new instance of CosmosValidatorAnnounce
    pub fn new(provider: CosmosProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
    }
}

impl HyperlaneContract for CosmosValidatorAnnounce {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl ValidatorAnnounce for CosmosValidatorAnnounce {
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

        let data: Vec<u8> = self.provider.grpc().wasm_query(payload, None).await?;
        let response: validator_announce::GetAnnounceStorageLocationsResponse =
            serde_json::from_slice(&data)?;

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

        let response: TxResponse = self
            .provider
            .grpc()
            // TODO: consider transaction overrides for Cosmos.
            .wasm_send(announce_request, None)
            .await?;

        Ok(tx_response_to_outcome(response)?)
    }

    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
        _chain_signer: H256,
    ) -> Option<U256> {
        // TODO: check user balance. For now, just try announcing and
        // allow the announce attempt to fail if there are not enough tokens.
        Some(0u64.into())
    }
}
