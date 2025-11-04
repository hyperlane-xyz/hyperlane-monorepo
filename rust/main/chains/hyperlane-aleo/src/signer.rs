use hyperlane_core::{ChainResult, H256};
use snarkvm::prelude::{Address, ComputeKey, FromBytes, Network, PrivateKey};

use crate::{utils::to_h256, CurrentNetwork, HyperlaneAleoError};

/// Aleo Signer
#[derive(Clone, Debug)]
pub struct AleoSigner {
    private_key: Vec<u8>,
    /// bech32 encoded address
    encoded_address: String,
    /// H256 representation of the address
    address_h256: H256,
}

impl AleoSigner {
    /// Creates a new Signer
    pub fn new(bytes: &[u8]) -> ChainResult<Self> {
        let private_key = PrivateKey::<CurrentNetwork>::from_bytes_le(&bytes)
            .map_err(HyperlaneAleoError::from)?;

        // Derive the compute key, view key, and address.
        let compute_key = ComputeKey::try_from(&private_key).map_err(HyperlaneAleoError::from)?;
        let address = Address::try_from(&compute_key).map_err(HyperlaneAleoError::from)?;

        Ok(Self {
            private_key: bytes.to_vec(),
            encoded_address: address.to_string(),
            address_h256: to_h256(address)?,
        })
    }

    /// Returns the Aleo Private key instance
    pub fn get_private_key<N: Network>(&self) -> ChainResult<PrivateKey<N>> {
        Ok(PrivateKey::<N>::from_bytes_le(&self.private_key).map_err(HyperlaneAleoError::from)?)
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
