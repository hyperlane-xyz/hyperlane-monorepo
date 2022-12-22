#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::abi::Token;
use ethers::providers::Middleware;
use ethers::types::Selector;

use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, MultisigIsm, MultisigSignedCheckpoint, RawHyperlaneMessage,
    SignatureWithSigner, H160, H256,
};

use crate::contracts::multisig_ism::{MultisigIsm as EthereumMultisigIsmInternal, MULTISIGISM_ABI};
use crate::trait_builder::BuildableWithProvider;

impl<M> std::fmt::Display for EthereumMultisigIsmInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct MultisigIsmBuilder {}

#[async_trait]
impl BuildableWithProvider for MultisigIsmBuilder {
    type Output = Box<dyn MultisigIsm>;

    async fn build_with_provider<M: Middleware + 'static>(
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
    domain: HyperlaneDomain,
}

impl<M> EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumMultisigIsmInternal::new(locator.address, provider)),
            domain: locator.domain.clone(),
        }
    }
}

impl<M> HyperlaneChain for EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }
}

impl<M> HyperlaneContract for EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
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
        message: HyperlaneMessage,
        checkpoint: &MultisigSignedCheckpoint,
        proof: Proof,
    ) -> ChainResult<Vec<u8>> {
        let root_bytes = checkpoint.checkpoint.root.to_fixed_bytes().into();
        let index_bytes = checkpoint.checkpoint.index.to_be_bytes().into();
        let proof_tokens: Vec<Token> = proof
            .path
            .iter()
            .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
            .collect();
        let mailbox_and_proof_bytes = ethers::abi::encode(&[
            Token::FixedBytes(
                checkpoint
                    .checkpoint
                    .mailbox_address
                    .to_fixed_bytes()
                    .into(),
            ),
            Token::FixedArray(proof_tokens),
        ]);
        let validators_and_threshold = self
            .contract
            .validators_and_threshold(RawHyperlaneMessage::from(&message).to_vec().into())
            .call()
            .await?;

        let threshold_bytes = validators_and_threshold.1.to_be_bytes().into();
        let validator_addresses = validators_and_threshold.0;

        // The ethers encoder likes to zero-pad non word-aligned byte arrays.
        // Thus, we pack the signatures, which are not word-aligned, ourselves.
        let signature_vecs: Vec<Vec<u8>> =
            order_signatures(&validator_addresses, &checkpoint.signatures);
        let signature_bytes = signature_vecs.concat();

        let validators: Vec<H256> = validator_addresses.iter().map(|&x| H256::from(x)).collect();
        let validator_tokens: Vec<Token> = validators
            .iter()
            .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
            .collect();
        let validator_bytes = ethers::abi::encode(&[Token::FixedArray(validator_tokens)]);

        let metadata = [
            root_bytes,
            index_bytes,
            mailbox_and_proof_bytes,
            threshold_bytes,
            signature_bytes,
            validator_bytes,
        ]
        .concat();
        Ok(metadata)
    }
}

pub struct EthereumMultisigIsmAbi;

impl HyperlaneAbi for EthereumMultisigIsmAbi {
    fn fn_map() -> HashMap<Selector, &'static str> {
        super::extract_fn_map(&MULTISIGISM_ABI)
    }
}

/// Orders `signatures` by the signers according to the `desired_order`.
/// Returns a Vec of the signature raw bytes in the correct order.
/// Panics if any signers in `signatures` are not present in `desired_order`
fn order_signatures(desired_order: &[H160], signatures: &[SignatureWithSigner]) -> Vec<Vec<u8>> {
    // Signer address => index to sort by
    let ordering_map: HashMap<H160, usize> = desired_order
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, a)| (a, index))
        .collect();

    // Create a tuple of (SignatureWithSigner, index to sort by)
    let mut ordered_signatures = signatures
        .iter()
        .cloned()
        .map(|s| {
            let order_index = ordering_map.get(&s.signer).unwrap();
            (s, *order_index)
        })
        .collect::<Vec<(SignatureWithSigner, usize)>>();
    // Sort by the index
    ordered_signatures.sort_by_key(|s| s.1);
    // Now collect only the raw signature bytes
    ordered_signatures
        .iter()
        .map(|s| s.0.signature.to_vec())
        .collect()
}
