//! Ethereum styled crypto scheme used in sovereign. This one is used in a main example of building
//! rollup with sovereign, that is in the `sov-rollup-starter`

use hyperlane_core::{ChainResult, H160, H256};
use k256::ecdsa::SigningKey;
use sha3::{Digest, Keccak256};

use crate::signers::Crypto;

/// Length of the sovereign address in bytes
pub const SOV_ADDRESS_LENGTH: usize = 20;
/// Amount of leading zeros padding in hex address representation.
pub const SOV_HEX_ADDRESS_LEADING_ZEROS: usize = 12;

/// Signer for Sovereign chain.
#[derive(Clone, Debug)]
pub struct Signer(SigningKey);

impl Signer {
    /// Create a new Sovereign ethereum signer.
    pub fn new(private_key: &H256) -> ChainResult<Self> {
        let private_key = SigningKey::from_slice(private_key.as_fixed_bytes().as_slice())
            .map_err(|e| custom_err!("Failed reading private key: {e}"))?;
        Ok(Signer(private_key))
    }

    /// Get the eth style address bytes
    fn h160_address(&self) -> H160 {
        let uncompressed = self.0.verifying_key().to_encoded_point(false);
        let pk_hash = Keccak256::digest(&uncompressed.as_bytes()[1..]);

        let addr: [_; SOV_ADDRESS_LENGTH] = pk_hash[SOV_HEX_ADDRESS_LEADING_ZEROS..]
            .try_into()
            .expect("Size must be correct");
        addr.into()
    }
}

impl Crypto for Signer {
    fn sign(&self, bytes: impl AsRef<[u8]>) -> ChainResult<Vec<u8>> {
        let digest = Keccak256::new_with_prefix(bytes.as_ref());

        self.0
            .sign_digest_recoverable(digest)
            .map(|(sig, _)| sig.to_bytes().to_vec())
            .map_err(|e| custom_err!("Signing failed: {e}"))
    }

    fn public_key(&self) -> Vec<u8> {
        let compressed = self.0.verifying_key().to_encoded_point(true);
        compressed.as_bytes().to_vec()
    }

    fn address(&self) -> ChainResult<String> {
        Ok(format!("{:?}", self.h160_address()))
    }

    fn h256_address(&self) -> H256 {
        self.h160_address().into()
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_address_from_h256() {
        // values from <https://github.com/Sovereign-Labs/sov-rollup-starter-wip/blob/fd8ccb34ba6133c4c7696d4829f8fd7ac404da19/test-data/keys/token_deployer_private_key.json>
        let private_key = H256([
            1, 135, 193, 46, 167, 193, 32, 36, 179, 247, 10, 197, 215, 53, 135, 70, 58, 241, 124,
            139, 206, 43, 217, 230, 254, 135, 56, 147, 16, 25, 108, 100,
        ]);
        let signer = Signer::new(&private_key).unwrap();

        assert_eq!(
            "0xa6edfca3aa985dd3cc728bffb700933a986ac085",
            signer.address().unwrap()
        );
        assert_eq!(
            "0x000000000000000000000000a6edfca3aa985dd3cc728bffb700933a986ac085",
            format!("{:?}", signer.h256_address()),
        );
    }
}
