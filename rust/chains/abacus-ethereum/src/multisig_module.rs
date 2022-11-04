#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::{sync::Arc};

use abacus_core::accumulator::merkle::Proof;
use async_trait::async_trait;
use ethers::abi::{Token};
use ethers::providers::Middleware;
use ethers::types::{H160, U256, H256, Selector};
use eyre::{Result};

use abacus_core::{
    AbacusAbi, AbacusContract, ChainCommunicationError, ContractLocator,
    MultisigModule, MultisigSignedCheckpoint,
};

use crate::contracts::multisig_module::{MultisigModule as EthereumMultisigModuleInternal, MULTISIGMODULE_ABI};
use crate::trait_builder::MakeableWithProvider;

impl<M> std::fmt::Display for EthereumMultisigModuleInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct MultisigModuleBuilder {}

impl MakeableWithProvider for MultisigModuleBuilder {
    type Output = Box<dyn MultisigModule>;

    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMultisigModule::new(Arc::new(provider), locator))
    }
}

/// A reference to an MultisigModule contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumMultisigModule<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMultisigModuleInternal<M>>,
    domain: u32,
    chain_name: String,
    provider: Arc<M>,
}

impl<M> EthereumMultisigModule<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumMultisigModuleInternal::new(
                &locator.address,
                provider.clone(),
            )),
            domain: locator.domain,
            chain_name: locator.chain_name.to_owned(),
            provider,
        }
    }
}

impl<M> AbacusContract for EthereumMultisigModule<M>
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
impl<M> MultisigModule for EthereumMultisigModule<M>
where
    M: Middleware + 'static,
{
    #[tracing::instrument(err, skip(self))]
    async fn threshold(
        &self,
        domain: u32
    ) -> Result<U256, ChainCommunicationError> {
        Ok(self.contract.threshold(domain).call().await?)
    }

    #[tracing::instrument(err, skip(self))]
    async fn validators(
        &self,
        domain: u32
    ) -> Result<Vec<H160>, ChainCommunicationError> {
        Ok(self.contract.validators(domain).call().await?)
    }


    /// Returns the metadata needed by the contract's verify function
    async fn format_metadata(&self, checkpoint: &MultisigSignedCheckpoint, proof: Proof) -> Result<Vec<u8>, ChainCommunicationError> {
        let threshold = self.threshold(checkpoint.checkpoint.mailbox_domain).await?;
        let validators: Vec<H256> = self.validators(checkpoint.checkpoint.mailbox_domain).await?.iter().map(|&x| H256::from(x)).collect();
        let proof_tokens: Vec<Token> = proof.path.iter().map(|&x| Token::FixedBytes(x.to_fixed_bytes().into())).collect();
        let validator_tokens: Vec<Token> = validators.iter().map(|&x| Token::FixedBytes(x.to_fixed_bytes().into())).collect();
        // TODO: This will not result in tight packing. May need to have a FixedArray of bytes1
        let signature_tokens: Vec<Token> = checkpoint.signatures.iter().map(|&x| Token::FixedBytes(x.to_vec())).collect();
        Ok(ethers::abi::encode(&[
            Token::FixedBytes(checkpoint.checkpoint.root.to_fixed_bytes().into()),
            Token::Uint(U256::from(checkpoint.checkpoint.index)),
            Token::FixedBytes(checkpoint.checkpoint.mailbox_address.to_fixed_bytes().into()),
            Token::FixedArray(proof_tokens),
            Token::Uint(threshold),
            Token::FixedArray(signature_tokens),
            Token::FixedArray(validator_tokens)
        ]))
    }
}

pub struct EthereumMultisigModuleAbi;

impl AbacusAbi for EthereumMultisigModuleAbi {
    fn fn_map() -> HashMap<Selector, &'static str> {
        super::extract_fn_map(&MULTISIGMODULE_ABI)
    }
}
