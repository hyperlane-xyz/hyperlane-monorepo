use async_trait::async_trait;

use cosmrs::{crypto::secp256k1::SigningKey, proto::cosmos::base::abci::v1beta1::TxResponse};
use hyperlane_core::{
    Announcement, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H256, U256,
};

use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    payloads::validator_announce::{
        self, AnnouncementRequest, AnnouncementRequestInner, GetAnnounceStorageLocationsRequest,
        GetAnnounceStorageLocationsRequestInner,
    },
    verify::{bech32_decode, pub_to_addr},
};

/// A reference to a ValidatorAnnounce contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosValidatorAnnounce {
    domain: HyperlaneDomain,
    address: String,
    provider: Box<WasmGrpcProvider>,
}

impl CosmosValidatorAnnounce {
    /// create a new instance of CosmosValidatorAnnounce
    pub fn new(
        domain: HyperlaneDomain,
        address: String,
        private_key: Vec<u8>,
        prefix: String,
        grpc_endpoint: String,
        chain_id: String,
    ) -> Self {
        let priv_key = SigningKey::from_slice(&private_key).unwrap();
        let signer_address = pub_to_addr(priv_key.public_key().to_bytes(), &prefix).unwrap();
        let provider = WasmGrpcProvider::new(
            address.clone(),
            private_key,
            signer_address,
            prefix,
            grpc_endpoint,
            chain_id,
        );

        Self {
            domain,
            address,
            provider: Box::new(provider),
        }
    }
}

impl HyperlaneContract for CosmosValidatorAnnounce {
    fn address(&self) -> H256 {
        bech32_decode(self.address.clone())
    }
}

impl HyperlaneChain for CosmosValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
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
        let payload = GetAnnounceStorageLocationsRequest {
            get_announce_storage_locations: GetAnnounceStorageLocationsRequestInner {
                validators: validators
                    .iter()
                    .map(|v| hex::encode(v.as_bytes()))
                    .collect::<Vec<String>>(),
            },
        };

        let data: Vec<u8> = self.provider.wasm_query(payload, None).await?;
        let response: validator_announce::GetAnnounceStorageLocationsResponse =
            serde_json::from_slice(&data)?;

        Ok(response
            .storage_locations
            .into_iter()
            .map(|v| v.1)
            .collect())
    }

    async fn announce(
        &self,
        announcement: SignedType<Announcement>,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let announce_request = AnnouncementRequest {
            announcement: AnnouncementRequestInner {
                validator: announcement.value.validator.to_string(),
                storage_location: announcement.value.storage_location,
                signature: hex::encode(announcement.signature.to_vec()),
            },
        };

        let response: TxResponse = self
            .provider
            .wasm_send(announce_request, tx_gas_limit)
            .await?;
        Ok(TxOutcome {
            txid: H256::from_slice(hex::decode(response.txhash).unwrap().as_slice()),
            executed: response.code == 0,
            gas_used: U256::from(response.gas_used),
            gas_price: U256::from(response.gas_wanted),
        })
    }

    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<U256> {
        todo!() // not implemented yet
    }
}
