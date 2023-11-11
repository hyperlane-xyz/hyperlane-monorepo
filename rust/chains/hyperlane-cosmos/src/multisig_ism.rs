use std::str::FromStr;

use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    signers::Signer,
    ConnectionConf, CosmosProvider,
};
use async_trait::async_trait;
use cosmwasm_std::HexBinary;
use hpl_interface::ism::IsmQueryMsg;
use hpl_interface::ism::VerifyInfoResponse;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, MultisigIsm, RawHyperlaneMessage, H160, H256,
};

/// A reference to a MultisigIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosMultisigIsm {
    domain: HyperlaneDomain,
    address: H256,
    provider: Box<WasmGrpcProvider>,
}

impl CosmosMultisigIsm {
    /// create a new instance of CosmosMultisigIsm
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider = WasmGrpcProvider::new(conf.clone(), locator.clone(), signer)?;

        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider: Box::new(provider),
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
        let payload = IsmQueryMsg::VerifyInfo {
            message: HexBinary::from(RawHyperlaneMessage::from(message)),
        };

        let data = self.provider.wasm_query(payload.wrap(), None).await?;
        let response: VerifyInfoResponse = serde_json::from_slice(&data)?;

        let validators: ChainResult<Vec<H256>> = response
            .validators
            .iter()
            .map(|v| {
                H160::from_str(&v.to_string())
                    .map(H256::from)
                    .map_err(Into::into)
            })
            .collect();

        Ok((validators?, response.threshold))
    }
}
