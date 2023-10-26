use std::str::FromStr;

use crate::{
    binary::h160_to_h256,
    grpc::{WasmGrpcProvider, WasmProvider},
    payloads::ism_routes::QueryIsmGeneralRequest,
    signers::Signer,
    ConnectionConf, CosmosProvider,
};
use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, MultisigIsm, RawHyperlaneMessage, H160, H256,
};

use crate::payloads::multisig_ism::{self, VerifyInfoRequest, VerifyInfoRequestInner};

/// A reference to a MultisigIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosMultisigIsm {
    _conf: ConnectionConf,
    domain: HyperlaneDomain,
    address: H256,
    _signer: Signer,
    provider: Box<WasmGrpcProvider>,
}

impl CosmosMultisigIsm {
    /// create a new instance of CosmosMultisigIsm
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

impl HyperlaneContract for CosmosMultisigIsm {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(CosmosProvider::new(self.domain.clone()))
    }
}

#[async_trait]
impl MultisigIsm for CosmosMultisigIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let payload = VerifyInfoRequest {
            verify_info: VerifyInfoRequestInner {
                message: hex::encode(RawHyperlaneMessage::from(message)),
            },
        };

        let data = self
            .provider
            .wasm_query(QueryIsmGeneralRequest { ism: payload }, None)
            .await?;
        let response: multisig_ism::VerifyInfoResponse = serde_json::from_slice(&data)?;

        let validators: Vec<H256> = response
            .validators
            .iter()
            .map(|v| h160_to_h256(H160::from_str(v).unwrap()))
            .collect();

        Ok((validators, response.threshold))
    }
}
