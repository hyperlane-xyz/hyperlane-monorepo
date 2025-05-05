use hyperlane_core::{ChainResult, H256};
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
    /// version of the signer
    pub version: u32,

    /// H256 address of the signer
    pub address_h256: H256,
}

impl Signer {
    /// create new signer
    ///
    /// # Arguments
    /// * `private_key` - private key for signer
    /// * `address` - address for signer
    /// * `version` - version of the signer
    pub fn new(private_key: &H256, address: &H256, version: u32) -> ChainResult<Self> {
        let contract_address = FieldElement::from_bytes_be(address.as_fixed_bytes())
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        let signing_key = Self::build_signing_key(private_key)?;

        Ok(Self {
            signing_key,
            address: contract_address,
            address_h256: *address,
            version,
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

    fn build_signing_key(private_key: &H256) -> ChainResult<SigningKey> {
        Ok(SigningKey::from_secret_scalar(
            FieldElement::from_bytes_be(private_key.as_fixed_bytes())
                .map_err(Into::<HyperlaneStarknetError>::into)?,
        ))
    }
}
