use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    verify,
};
use async_trait::async_trait;
use cosmrs::crypto::secp256k1::SigningKey;
use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, MultisigIsm, RawHyperlaneMessage, H256,
};

use crate::{
    payloads::multisig_ism::{self, VerifyInfoRequest, VerifyInfoRequestInner},
    verify::bech32_decode,
};

/// A reference to a MultisigIsm contract on some Cosmos chain
#[derive(Debug)]
pub struct CosmosMultisigIsm<'a> {
    conf: &'a ConnectionConf,
    locator: &'a ContractLocator<'a>,
    signer: &'a Signer,
    provider: Box<WasmGrpcProvider<'a>>,
}

impl CosmosMultisigIsm {
    /// create a new instance of CosmosMultisigIsm
    pub fn new(
        domain: HyperlaneDomain,
        address: String,
        prefix: String,
        private_key: Vec<u8>,
        grpc_endpoint: String,
        chain_id: String,
    ) -> Self {
        let signer_address = verify::pub_to_addr(
            SigningKey::from_slice(&private_key)
                .unwrap()
                .public_key()
                .to_bytes(),
            &prefix,
        )
        .unwrap();

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

impl HyperlaneContract for CosmosMultisigIsm {
    fn address(&self) -> H256 {
        bech32_decode(self.address.clone())
    }
}

impl HyperlaneChain for CosmosMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
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
