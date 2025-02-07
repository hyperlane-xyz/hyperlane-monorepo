use std::fmt::{Display, Formatter};

use elliptic_curve::sec1::ToEncodedPoint;

#[derive(Debug, thiserror::Error)]
pub enum PublicKeyError {
    Decode(String),
}

impl Display for PublicKeyError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

/// Decompresses public key of secp256k1 if it was compressed
///
/// Public key can be expressed in compressed or decompressed forms.
/// Compressed form contains one byte as prefix and x component of the public key.
/// Decompressed form contains one byte as prefix, x and y components of the public key.
pub fn decompress_public_key(public_key: &[u8]) -> Result<Vec<u8>, PublicKeyError> {
    let elliptic: elliptic_curve::PublicKey<k256::Secp256k1> =
        elliptic_curve::PublicKey::from_sec1_bytes(public_key)
            .map_err(|e| PublicKeyError::Decode(e.to_string()))?;

    // if public key was compressed, encoding into the point will decompress it.
    let point = elliptic.to_encoded_point(false);
    let decompressed = point.to_bytes().to_vec();
    Ok(decompressed)
}

#[cfg(test)]
mod tests {
    use crate::key::decompress_public_key;

    #[test]
    fn test_decompress_public_key() {
        // given
        let compressed = "02962d010010b6eec66846322704181570d89e28236796579c535d2e44d20931f4";
        let hex = hex::decode(compressed).unwrap();

        // when
        let decompressed = hex::encode(decompress_public_key(&hex).unwrap());

        // then
        assert_eq!(
            "04962d010010b6eec66846322704181570d89e28236796579c535d2e44d20931f40cb1152fb9e61ec7493a0d9a35d2e8a57198e109613854abdd3be5603d504008",
            decompressed
        );
    }
}
