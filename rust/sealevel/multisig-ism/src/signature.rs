use hyperlane_core::{Encode, H160};
use solana_program::{
    keccak,
    secp256k1_recover::{secp256k1_recover, Secp256k1RecoverError},
};

use crate::error::EcdsaSignatureError;

/// An ECDSA signature with a recovery ID.
/// Signature recovery functions expect a 64 byte serialized r & s value and a 1 byte recovery ID
/// that is either 0 or 1.
/// This type is used to deserialize a 65 byte signature & allow easy recovery of the Ethereum
/// address signer.
#[derive(Debug, Eq, PartialEq)]
pub struct EcdsaSignature {
    pub serialized_rs: [u8; 64],
    pub recovery_id: u8,
}

impl EcdsaSignature {
    /// Deserializes a 65 byte signature into an EcdsaSignature.
    /// The recovery ID, i.e. the `v` value, must be 0, 1, 27, or 28.
    /// If it is 27 or 28, it's normalized to 0 or 1, which is what's required
    /// by the secp256k1_recover function.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, EcdsaSignatureError> {
        if bytes.len() != 65 {
            return Err(EcdsaSignatureError::InvalidLength);
        }

        let mut serialized_rs = [0u8; 64];
        serialized_rs.copy_from_slice(&bytes[..64]);

        let mut recovery_id = bytes[64];
        if recovery_id == 27 || recovery_id == 28 {
            recovery_id -= 27;
        }

        // Recovery ID must be 0 or 1
        if recovery_id > 1 {
            return Err(EcdsaSignatureError::InvalidRecoveryId);
        }

        Ok(Self {
            serialized_rs,
            recovery_id,
        })
    }

    /// Serializes the signature into a 65 byte array.
    #[allow(dead_code)]
    pub fn as_fixed_bytes(&self) -> [u8; 65] {
        let mut bytes = [0u8; 65];
        bytes[..64].copy_from_slice(&self.serialized_rs[..]);
        bytes[64] = self.recovery_id;
        bytes
    }

    /// Recovers the Ethereum address of the signer of the signed message hash.
    pub fn secp256k1_recover_ethereum_address(
        &self,
        hash: &[u8],
    ) -> Result<H160, Secp256k1RecoverError> {
        let public_key = secp256k1_recover(hash, self.recovery_id, self.serialized_rs.as_slice())?;

        let public_key_hash = {
            let mut hasher = keccak::Hasher::default();
            hasher.hash(&public_key.to_bytes()[..]);
            &hasher.result().to_bytes()[12..]
        };

        Ok(H160::from_slice(public_key_hash))
    }
}

#[cfg(test)]
mod test {
    use super::*;

    use hyperlane_core::H256;

    #[test]
    fn test_decode_invalid_length() {
        let bytes = [0u8; 64];
        assert!(
            EcdsaSignature::from_bytes(&bytes[..]).unwrap_err()
                == EcdsaSignatureError::InvalidLength
        );

        let bytes = [0u8; 66];
        assert!(
            EcdsaSignature::from_bytes(&bytes[..]).unwrap_err()
                == EcdsaSignatureError::InvalidLength
        );
    }

    #[test]
    fn test_decode_ecdsa_signature() {
        // Various recovery ids. (encoded, decoded - Some is valid, None means err is expected)
        let valid_recovery_ids = vec![
            // Valid ones
            (0, Some(0)),
            (1, Some(1)),
            (27, Some(0)),
            (28, Some(1)),
            // Invalid ones
            (2, None),
            (3, None),
            (26, None),
            (29, None),
        ];

        for (encoded_recovery_id, decoded_recovery_id) in valid_recovery_ids {
            let mut rs = [0u8; 64];
            rs[..32].copy_from_slice(&H256::random()[..]);
            rs[32..].copy_from_slice(&H256::random()[..]);

            let mut bytes = [0u8; 65];
            bytes[..64].copy_from_slice(&rs[..]);
            bytes[64] = encoded_recovery_id;

            let signature_result = EcdsaSignature::from_bytes(&bytes);

            match decoded_recovery_id {
                Some(decoded_recovery_id) => {
                    let signature = signature_result.unwrap();
                    assert_eq!(
                        signature,
                        EcdsaSignature {
                            serialized_rs: rs.into(),
                            recovery_id: decoded_recovery_id,
                        }
                    );
                }
                None => {
                    assert!(signature_result.is_err());
                    assert!(
                        signature_result.unwrap_err()
                            == EcdsaSignatureError::InvalidRecoveryId.into()
                    );
                }
            }
        }
    }
}
