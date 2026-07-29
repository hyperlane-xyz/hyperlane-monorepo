use hyperlane_core::H160;
use solana_program::{
    keccak,
    secp256k1_recover::{secp256k1_recover, Secp256k1RecoverError},
};

/// Errors relating to an EcdsaSignature
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, PartialEq)]
pub enum EcdsaSignatureError {
    #[error("Invalid signature length")]
    InvalidLength,
    #[error("Invalid signature recovery ID")]
    InvalidRecoveryId,
    #[error("Signature s value is in the upper half order (non-canonical)")]
    HighS,
}

/// Half the secp256k1 curve order (n / 2), big-endian. A signature is canonical
/// (low-S) only when `s <= n/2`; larger `s` values are rejected so each
/// signature has a single valid encoding (otherwise `(r, n - s, v ^ 1)` is a
/// second encoding of the same signature).
const SECP256K1_HALF_ORDER: [u8; 32] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA0,
];

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

        // Enforce low-S: reject s > n/2 so the signature has a single canonical
        // encoding. This covers every caller of the shared library.
        if serialized_rs[32..] > SECP256K1_HALF_ORDER[..] {
            return Err(EcdsaSignatureError::HighS);
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
            let hash = keccak::hash(&public_key.to_bytes()[..]);
            &hash.to_bytes()[12..]
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
            // Force s into the lower half order so the low-S check accepts it;
            // this test only exercises recovery-id decoding.
            rs[32] = 0;

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
                            serialized_rs: rs,
                            recovery_id: decoded_recovery_id,
                        }
                    );
                }
                None => {
                    assert!(signature_result.is_err());
                    assert!(
                        signature_result.unwrap_err() == EcdsaSignatureError::InvalidRecoveryId
                    );
                }
            }
        }
    }

    /// The full secp256k1 curve order (n), big-endian.
    const SECP256K1_ORDER: [u8; 32] = [
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFE, 0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36,
        0x41, 0x41,
    ];

    /// Builds a 65-byte signature with an arbitrary `r`, the given `s`, and `v = 0`.
    fn signature_with_s(s: &[u8; 32]) -> [u8; 65] {
        let mut bytes = [0u8; 65];
        bytes[..32].copy_from_slice(&[0x11u8; 32]); // arbitrary r
        bytes[32..64].copy_from_slice(s);
        bytes[64] = 0;
        bytes
    }

    /// Big-endian `a - b`, assuming `a >= b`.
    fn be_sub(a: [u8; 32], b: &[u8; 32]) -> [u8; 32] {
        let mut out = [0u8; 32];
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let diff = a[i] as i16 - b[i] as i16 - borrow;
            if diff < 0 {
                out[i] = (diff + 256) as u8;
                borrow = 1;
            } else {
                out[i] = diff as u8;
                borrow = 0;
            }
        }
        out
    }

    #[test]
    fn test_rejects_high_s_signatures() {
        // s == n/2 is the largest canonical value: accepted.
        assert!(EcdsaSignature::from_bytes(&signature_with_s(&SECP256K1_HALF_ORDER)).is_ok());

        // s == n/2 + 1 is the smallest non-canonical value: rejected.
        let mut just_above = SECP256K1_HALF_ORDER;
        just_above[31] += 1;
        assert_eq!(
            EcdsaSignature::from_bytes(&signature_with_s(&just_above)).unwrap_err(),
            EcdsaSignatureError::HighS
        );

        // A low-S signature is accepted, but its malleable twin (r, n - s) is
        // high-S and must be rejected — so a single signature cannot have two
        // valid encodings.
        let mut low_s = [0u8; 32];
        low_s[31] = 1;
        assert!(EcdsaSignature::from_bytes(&signature_with_s(&low_s)).is_ok());

        let malleable_s = be_sub(SECP256K1_ORDER, &low_s);
        assert_eq!(
            EcdsaSignature::from_bytes(&signature_with_s(&malleable_s)).unwrap_err(),
            EcdsaSignatureError::HighS
        );
    }
}
