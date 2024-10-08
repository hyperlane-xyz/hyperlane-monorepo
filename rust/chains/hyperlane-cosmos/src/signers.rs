use cosmrs::crypto::{secp256k1::SigningKey, PublicKey};
use hyperlane_core::ChainResult;

use crate::{address::CosmosAddress, HyperlaneCosmosError};

#[derive(Clone, Debug)]
/// Signer for cosmos chain
pub struct Signer {
    /// public key
    pub public_key: PublicKey,
    /// precomputed address, because computing it is a fallible operation
    /// and we want to avoid returning `Result`
    pub address: String,
    /// address prefix
    pub prefix: String,
    private_key: Vec<u8>,
}

impl Signer {
    /// create new signer
    ///
    /// # Arguments
    /// * `private_key` - private key for signer
    /// * `prefix` - prefix for signer address
    pub fn new(private_key: Vec<u8>, prefix: String) -> ChainResult<Self> {
        let address = CosmosAddress::from_privkey(&private_key, &prefix)?.address();
        let signing_key = Self::build_signing_key(&private_key)?;
        let public_key = signing_key.public_key();
        Ok(Self {
            public_key,
            private_key,
            address,
            prefix,
        })
    }

    /// Build a SigningKey from a private key. This cannot be
    /// precompiled and stored in `Signer`, because `SigningKey` is not `Sync`.
    pub fn signing_key(&self) -> ChainResult<SigningKey> {
        Self::build_signing_key(&self.private_key)
    }

    fn build_signing_key(private_key: &Vec<u8>) -> ChainResult<SigningKey> {
        Ok(SigningKey::from_slice(private_key.as_slice())
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }
}
