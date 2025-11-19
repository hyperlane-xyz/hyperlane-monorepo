use ed25519_dalek::{Signer as _, SigningKey};
use hyperlane_core::{ChainResult, H256};

use crate::signers::Crypto;

/// Signer for Sovereign chain.
#[derive(Clone, Debug)]
pub struct Signer(SigningKey);

impl Signer {
    /// Create a new Sovereign ed25519 signer.
    pub fn new(private_key: &H256) -> ChainResult<Self> {
        let private_key = private_key.as_fixed_bytes().into();
        Ok(Signer(private_key))
    }
}

impl Crypto for Signer {
    fn sign(&self, bytes: &[u8]) -> ChainResult<Vec<u8>> {
        Ok(self.0.sign(bytes.as_ref()).to_bytes().to_vec())
    }

    fn public_key(&self) -> Vec<u8> {
        self.0.verifying_key().as_bytes().to_vec()
    }

    fn address(&self) -> ChainResult<String> {
        Ok(bs58::encode(self.0.verifying_key().as_bytes()).into_string())
    }

    fn h256_address(&self) -> H256 {
        H256::from_slice(self.0.verifying_key().as_bytes())
    }

    fn credential_id(&self) -> Vec<u8> {
        self.public_key()
    }
}
