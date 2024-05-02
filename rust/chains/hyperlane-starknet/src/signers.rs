use hyperlane_core::ChainResult;
use starknet::{
    core::types::FieldElement,
    signers::{LocalWallet, SigningKey},
};

use crate::error::HyperlaneStarknetError;

/// A signer for Starknet accounts
#[derive(Clone, Debug)]
pub struct Signer {
    /// signing key
    pub signing_key: SigningKey,
    /// account address
    pub address: FieldElement,
}

impl Signer {
    /// create new signer
    ///
    /// # Arguments
    /// * `private_key` - private key for signer
    /// * `address` - address for signer
    pub fn new(private_key: &str, address: &str) -> ChainResult<Self> {
        // TODO: possible to compute it from pk ?
        let contract_address =
            FieldElement::from_hex_be(address).map_err(Into::<HyperlaneStarknetError>::into)?;
        let signing_key = Self::build_signing_key(private_key)?;

        Ok(Self {
            signing_key,
            address: contract_address,
        })
    }

    /// Build a SigningKey from a private key. This cannot be
    /// precompiled and stored in `Signer`, because `SigningKey` is not `Sync`.
    pub fn signing_key(&self) -> SigningKey {
        self.signing_key.clone()
    }

    /// Get the local wallet for the signer
    pub fn local_wallet(&self) -> LocalWallet {
        LocalWallet::from(self.signing_key())
    }

    fn build_signing_key(private_key: &str) -> ChainResult<SigningKey> {
        Ok(SigningKey::from_secret_scalar(
            FieldElement::from_hex_be(private_key).map_err(Into::<HyperlaneStarknetError>::into)?,
        ))
    }
}
