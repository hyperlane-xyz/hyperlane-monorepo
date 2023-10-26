use async_trait::async_trait;

use cosmrs::proto::cosmos::base::abci::v1beta1::TxResponse;
use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H256, U256,
};

use crate::{
    binary::h256_to_h160,
    grpc::{WasmGrpcProvider, WasmProvider},
    payloads::validator_announce::{
        self, AnnouncementRequest, AnnouncementRequestInner, GetAnnounceStorageLocationsRequest,
        GetAnnounceStorageLocationsRequestInner,
    },
    signers::Signer,
    ConnectionConf, CosmosProvider,
};

/// A reference to a ValidatorAnnounce contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosValidatorAnnounce {
    _conf: ConnectionConf,
    domain: HyperlaneDomain,
    address: H256,
    _signer: Signer,
    provider: Box<WasmGrpcProvider>,
}

impl CosmosValidatorAnnounce {
    /// create a new instance of CosmosValidatorAnnounce
    pub fn new(conf: ConnectionConf, locator: ContractLocator, signer: Signer) -> Self {
        let provider = WasmGrpcProvider::new(conf.clone(), locator.clone(), signer.clone());

        Self {
            _conf: conf,
            domain: locator.domain.clone(),
            address: locator.address,
            _signer: signer,
            provider: Box::new(provider),
        }
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
        Box::new(CosmosProvider::new(self.domain.clone()))
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
            .map(|v| h256_to_h160(*v))
            .map(|v| hex::encode(v.as_bytes()))
            .collect::<Vec<String>>();

        let payload = GetAnnounceStorageLocationsRequest {
            get_announce_storage_locations: GetAnnounceStorageLocationsRequestInner {
                validators: vss,
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
            announce: AnnouncementRequestInner {
                validator: hex::encode(announcement.value.validator),
                storage_location: announcement.value.storage_location,
                signature: hex::encode(announcement.signature.to_vec()),
            },
        };

        let response: TxResponse = self
            .provider
            .wasm_send(announce_request, tx_gas_limit)
            .await?;

        Ok(TxOutcome {
            transaction_id: H256::from_slice(hex::decode(response.txhash).unwrap().as_slice())
                .into(),
            executed: response.code == 0,
            gas_used: U256::from(response.gas_used),
            gas_price: U256::from(response.gas_wanted),
        })
    }

    async fn announce_tokens_needed(&self, announcement: SignedType<Announcement>) -> Option<U256> {
        // TODO: check user balance. For now, just try announcing and
        // allow the announce attempt to fail if there are not enough tokens.
        Some(0u64.into())
    }
}
