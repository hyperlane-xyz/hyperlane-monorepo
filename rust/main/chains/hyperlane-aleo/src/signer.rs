use hyperlane_core::{ChainResult, H256};
use snarkvm::prelude::{Address, ComputeKey, FromBytes, PrivateKey};

use crate::{to_h256, CurrentNetwork, HyperlaneAleoError};

/// Aleo Signer
#[derive(Clone, Debug)]
pub struct AleoSigner {
    private_key: PrivateKey<CurrentNetwork>,
    /// bech32 encoded address
    encoded_address: String,
    /// H256 representation of the address
    address_h256: H256,
}

impl AleoSigner {
    /// Creates a new Signer
    pub fn new(private_key: &[u8]) -> ChainResult<Self> {
        let private_key = PrivateKey::<CurrentNetwork>::from_bytes_le(&private_key)
            .map_err(HyperlaneAleoError::from)?;

        // Derive the compute key, view key, and address.
        let compute_key = ComputeKey::try_from(&private_key).map_err(HyperlaneAleoError::from)?;
        let address = Address::try_from(&compute_key).map_err(HyperlaneAleoError::from)?;

        Ok(Self {
            private_key,
            encoded_address: address.to_string(),
            address_h256: to_h256(address)?,
        })
    }

    /// Returns the Aleo Private key instance
    pub fn get_private_key(&self) -> &PrivateKey<CurrentNetwork> {
        &self.private_key
    }

    /// Returns the corresponding Address as string formatted
    pub fn address(&self) -> &str {
        &self.encoded_address
    }

    /// Returns the corresponding Address encoded as H256
    pub fn address_h256(&self) -> H256 {
        self.address_h256
    }
}
