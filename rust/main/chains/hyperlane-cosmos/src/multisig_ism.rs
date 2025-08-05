use std::str::FromStr;

use crate::{
    grpc::WasmProvider, payloads::ism_routes::QueryIsmGeneralRequest, signers::Signer,
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
    domain: HyperlaneDomain,
    address: H256,
    provider: CosmosProvider,
}

impl CosmosMultisigIsm {
    /// create a new instance of CosmosMultisigIsm
    pub fn new(provider: CosmosProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
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
        Box::new(self.provider.clone())
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
            .grpc()
            .wasm_query(QueryIsmGeneralRequest { ism: payload }, None)
            .await?;
        let response: multisig_ism::VerifyInfoResponse = serde_json::from_slice(&data)?;

        let validators: ChainResult<Vec<H256>> = response
            .validators
            .iter()
            .map(|v| H160::from_str(v).map(H256::from).map_err(Into::into))
            .collect();

        Ok((validators?, response.threshold))
    }
}
