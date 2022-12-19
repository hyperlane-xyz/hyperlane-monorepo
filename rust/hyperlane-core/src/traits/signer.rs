use async_trait::async_trait;
use ethers::prelude::Signature;
use primitive_types::H256;

#[derive(thiserror::Error, Debug)]
#[error(transparent)]
pub struct HyperlaneSignerError(#[from] Box<dyn std::error::Error>);

#[async_trait]
pub trait HyperlaneSigner {
    /// The signer's address
    fn address(&self) -> H256;
    
    /// Sign a hyperlane checkpoint hash. This must be a signature without eip 155.
    async fn sign_hash(
        &self,
        hash: &H256,
    ) -> Result<Signature, HyperlaneSignerError>;
}
