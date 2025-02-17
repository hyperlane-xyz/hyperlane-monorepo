use anyhow::{bail, Result};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};

/// Collection of Private Key types.
#[derive(Clone, Debug)]
pub enum PrivateKey {
    Ed25519(SigningKey),
}

/// Collection of Hashers.
#[derive(Clone, Debug)]
pub enum Hasher {
    Sha256,
}

/// Collection of Address types.
#[derive(Clone, Debug)]
pub enum Address {
    Bech32m { hrp: bech32::Hrp, size_bytes: usize },
}

/// Struct for Crypto.
#[derive(Clone, Debug)]
pub struct Crypto {
    pub private_key: PrivateKey,
    pub hasher: Hasher,
    pub address_type: Address,
}

impl Crypto {
    /// Do signature.
    #[must_use]
    pub fn sign(&self, input: &[u8]) -> Vec<u8> {
        match self.private_key {
            PrivateKey::Ed25519(ref key) => key.sign(input).to_bytes().to_vec(),
        }
    }

    /// Get the pub key.
    #[must_use]
    pub fn public_key(&self) -> Vec<u8> {
        match self.private_key {
            PrivateKey::Ed25519(ref key) => key.verifying_key().as_bytes().to_vec(),
        }
    }

    /// Get an address.
    pub fn address(&self) -> Result<String> {
        let hash = match self.hasher {
            Hasher::Sha256 => {
                let mut h = Sha256::new();
                h.update(self.public_key());
                h.finalize()
            }
        };

        match self.address_type {
            Address::Bech32m { hrp, size_bytes } => {
                let mut bech32_address = String::new();
                if size_bytes > hash.len() {
                    bail!("address size > hash size")
                }
                bech32::encode_to_fmt::<bech32::Bech32m, String>(
                    &mut bech32_address,
                    hrp,
                    &hash[..size_bytes],
                )?;
                Ok(bech32_address)
            }
        }
    }
}
