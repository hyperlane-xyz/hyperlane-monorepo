use async_trait::async_trait;
use auto_impl::auto_impl;
use ethers::prelude::Signature;
use primitive_types::H256;
use std::fmt::Debug;
use crate::{Signable, SignedType};

/// An error incurred by a signer
#[derive(thiserror::Error, Debug)]
#[error(transparent)]
pub struct HyperlaneSignerError(#[from] Box<dyn std::error::Error + Send + Sync>);

/// A hyperlane signer for use by the validators.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneSigner: Send + Sync + Debug {
    /// The signer's address
    fn address(&self) -> H256;

    /// Sign a hyperlane checkpoint hash. This must be a signature without eip 155.
    async fn sign_hash(&self, hash: &H256) -> Result<Signature, HyperlaneSignerError>;

    async fn sign<S: Signable>(&self, value: S) -> Result<SignedType<S>, HyperlaneSignerError> {
        let signing_hash = value.signing_hash();
        let signature = self.sign_hash(&signing_hash).await?;
        Ok(SignedType {
            value,
            signature,
        })
    }
}
