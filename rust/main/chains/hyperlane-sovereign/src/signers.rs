use ethers::types::Address;
use hyperlane_core::{ChainCommunicationError, ChainResult, H256};
use k256::ecdsa::SigningKey;
use sha3::{Digest, Keccak256};

/// Signer for Sovereign chain.
#[derive(Clone, Debug)]
pub struct Signer {
    /// The Signer's address.
    pub address: String,
}

impl Signer {
    /// Create a new Sovereign signer.
    pub fn new(private_key: &H256) -> ChainResult<Self> {
        let address = address_from_h256(private_key)?;
        Ok(Signer { address })
    }
}

fn address_from_h256(private_key: &H256) -> ChainResult<String> {
    let signing_key = SigningKey::from_bytes(private_key.as_bytes().into())
        .map_err(|e| ChainCommunicationError::CustomError(format!("Key Failure: {e:?}")))?;
    let public_key = signing_key.verifying_key();

    let binding = public_key.to_encoded_point(false);
    let public_key_bytes = binding.as_bytes();

    let hash = Keccak256::digest(&public_key_bytes[1..]);
    let address = Address::from_slice(&hash[12..]);
    let address = format!("{address:?}");

    Ok(address)
}

#[cfg(test)]
mod test {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn test_address_from_h256() {
        let private_key =
            H256::from_str("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
                .unwrap();
        let res = address_from_h256(&private_key).unwrap();
        assert_eq!("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", res)
    }
}
