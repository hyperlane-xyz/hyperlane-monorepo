#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use abacus_core::accumulator::merkle::Proof;
use async_trait::async_trait;
use ethers::abi::Token;
use ethers::providers::Middleware;
use ethers::types::{Selector, H160, H256, U256};
use eyre::Result;

use abacus_core::{
    AbacusAbi, AbacusContract, ChainCommunicationError, ContractLocator, MultisigIsm,
    MultisigSignedCheckpoint,
};

use crate::contracts::multisig_ism::{MultisigIsm as EthereumMultisigIsmInternal, MULTISIGISM_ABI};
use crate::trait_builder::MakeableWithProvider;

impl<M> std::fmt::Display for EthereumMultisigIsmInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct MultisigIsmBuilder {}

impl MakeableWithProvider for MultisigIsmBuilder {
    type Output = Box<dyn MultisigIsm>;

    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMultisigIsm::new(Arc::new(provider), locator))
    }
}

/// A reference to an MultisigIsm contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumMultisigIsm<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMultisigIsmInternal<M>>,
    #[allow(dead_code)]
    domain: u32,
    chain_name: String,
    #[allow(dead_code)]
    provider: Arc<M>,
}

impl<M> EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumMultisigIsmInternal::new(
                &locator.address,
                provider.clone(),
            )),
            domain: locator.domain,
            chain_name: locator.chain_name.to_owned(),
            provider,
        }
    }
}

impl<M> AbacusContract for EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    fn chain_name(&self) -> &str {
        &self.chain_name
    }

    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> MultisigIsm for EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    /// Returns the metadata needed by the contract's verify function
    async fn format_metadata(
        &self,
        checkpoint: &MultisigSignedCheckpoint,
        proof: Proof,
    ) -> Result<Vec<u8>, ChainCommunicationError> {
        let threshold = self.threshold(checkpoint.checkpoint.mailbox_domain).await?;
        let validators: Vec<H256> = self
            .validators(checkpoint.checkpoint.mailbox_domain)
            .await?
            .iter()
            .map(|&x| H256::from(x))
            .collect();
        let validator_tokens: Vec<Token> = validators
            .iter()
            .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
            .collect();
        let proof_tokens: Vec<Token> = proof
            .path
            .iter()
            .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
            .collect();
        let prefix = ethers::abi::encode(&[
            Token::FixedBytes(checkpoint.checkpoint.root.to_fixed_bytes().into()),
            Token::Uint(U256::from(checkpoint.checkpoint.index)),
            Token::FixedBytes(
                checkpoint
                    .checkpoint
                    .mailbox_address
                    .to_fixed_bytes()
                    .into(),
            ),
            Token::FixedArray(proof_tokens),
            Token::Uint(threshold),
        ]);
        let suffix = ethers::abi::encode(&[Token::FixedArray(validator_tokens)]);
        // The ethers encoder likes to zero-pad non word-aligned byte arrays.
        // Thus, we pack the signatures, which are not word-aligned, ourselves.
        let signature_vecs: Vec<Vec<u8>> =
            checkpoint.signatures.iter().map(|x| x.to_vec()).collect();
        let signature_bytes = signature_vecs.concat();
        let metadata = [prefix, signature_bytes, suffix].concat();
        Ok(metadata)
    }

    #[tracing::instrument(err, skip(self))]
    async fn threshold(&self, domain: u32) -> Result<U256, ChainCommunicationError> {
        Ok(self.contract.threshold(domain).call().await?)
    }

    #[tracing::instrument(err, skip(self))]
    async fn validators(&self, domain: u32) -> Result<Vec<H160>, ChainCommunicationError> {
        Ok(self.contract.validators(domain).call().await?)
    }
}

pub struct EthereumMultisigIsmAbi;

impl AbacusAbi for EthereumMultisigIsmAbi {
    fn fn_map() -> HashMap<Selector, &'static str> {
        super::extract_fn_map(&MULTISIGISM_ABI)
    }
}
