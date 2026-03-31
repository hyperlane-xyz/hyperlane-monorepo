use hyperlane_core::{ChainResult, H256};
use snarkvm::prelude::{Address, ComputeKey, FromBytes, Network, PrivateKey};

use crate::{utils::to_h256, CurrentNetwork, HyperlaneAleoError};

/// Converts bytes to a PrivateKey for the specified network
fn bytes_to_private_key<N: Network>(bytes: &[u8]) -> ChainResult<PrivateKey<N>> {
    Ok(PrivateKey::<N>::from_bytes_le(bytes).map_err(HyperlaneAleoError::from)?)
}

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
        let private_key = bytes_to_private_key::<CurrentNetwork>(bytes)?;

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
        bytes_to_private_key::<N>(&self.private_key)
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

#[cfg(test)]
mod tests {
    use snarkvm::utilities::rand;
    use snarkvm_console_account::ToBytes;

    use super::*;

    #[test]
    fn test_bytes_to_private_key_valid() {
        // Create a valid private key and convert it to bytes
        let original_key =
            PrivateKey::<CurrentNetwork>::new(&mut rand::TestRng::default()).unwrap();
        let bytes = original_key.to_bytes_le().unwrap();

        // Test conversion back
        let result = bytes_to_private_key::<CurrentNetwork>(&bytes);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), original_key);
    }

    #[test]
    fn test_bytes_to_private_key_invalid() {
        // Test with invalid bytes (wrong length)
        let invalid_bytes = vec![0u8; 10];
        let result = bytes_to_private_key::<CurrentNetwork>(&invalid_bytes);
        assert!(result.is_err());
    }

    #[test]
    fn test_bytes_to_private_key_empty() {
        // Test with empty bytes
        let empty_bytes: Vec<u8> = vec![];
        let result = bytes_to_private_key::<CurrentNetwork>(&empty_bytes);
        assert!(result.is_err());
    }
}
