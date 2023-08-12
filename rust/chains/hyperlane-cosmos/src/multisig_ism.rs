use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    signers::Signer,
    ConnectionConf,
};
use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, MultisigIsm, RawHyperlaneMessage, H256,
};

use crate::{
    payloads::multisig_ism::{self, VerifyInfoRequest, VerifyInfoRequestInner},
    verify::bech32_decode,
};

/// A reference to a MultisigIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosMultisigIsm<'a> {
    _conf: &'a ConnectionConf,
    locator: &'a ContractLocator<'a>,
    _signer: &'a Signer,
    provider: Box<WasmGrpcProvider<'a>>,
}

impl<'a> CosmosMultisigIsm<'a> {
    /// create a new instance of CosmosMultisigIsm
    pub fn new(conf: &'a ConnectionConf, locator: &'a ContractLocator, signer: &'a Signer) -> Self {
        let provider = WasmGrpcProvider::new(conf, locator, signer);

        Self {
            _conf: conf,
            locator,
            _signer: signer,
            provider: Box::new(provider),
        }
    }
}

impl HyperlaneContract for CosmosMultisigIsm<'_> {
    fn address(&self) -> H256 {
        self.locator.address
    }
}

impl HyperlaneChain for CosmosMultisigIsm<'_> {
    fn domain(&self) -> &HyperlaneDomain {
        self.locator.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

#[async_trait]
impl MultisigIsm for CosmosMultisigIsm<'_> {
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

        let data = self.provider.wasm_query(payload, None).await?;
        let response: multisig_ism::VerifyInfoResponse = serde_json::from_slice(&data)?;

        let validators: Vec<H256> = response
            .validators
            .iter()
            .map(|v| bech32_decode(v.clone()))
            .collect();

        Ok((validators, response.threshold))
    }
}
