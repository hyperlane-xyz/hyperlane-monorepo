use std::cmp;

use bech32::{FromBase32, ToBase32};
use hyperlane_core::{ChainCommunicationError, ChainResult, H256};
use ripemd::Ripemd160;
use sha2::{Digest, Sha256};

/// decode bech32 address to H256
pub fn bech32_decode(addr: String) -> H256 {
    let (_hrp, data, _variant) = bech32::decode(addr.as_str()).unwrap();

    let value = Vec::<u8>::from_base32(&data).unwrap();
    let mut result: [u8; 32] = [0; 32];

    let start_point = cmp::max(0, 32 - value.len());
    result[start_point..32].copy_from_slice(value.as_slice());

    H256::from(result)
}

/// encode H256 to bech32 address
pub fn digest_to_addr(digest: H256, prefix: &str) -> ChainResult<String> {
    let addr = bech32::encode(
        prefix,
        digest.as_bytes().to_base32(),
        bech32::Variant::Bech32,
    )
    .map_err(|_| ChainCommunicationError::InvalidRequest {
        msg: "invalid address".to_string(),
    })?;

    Ok(addr)
}

/// encode H256 to bech32 address
pub fn sha256_digest(bz: impl AsRef<[u8]>) -> ChainResult<[u8; 32]> {
    let mut hasher = Sha256::new();

    hasher.update(bz);

    hasher
        .finalize()
        .as_slice()
        .try_into()
        .map_err(|_| ChainCommunicationError::ParseError {
            msg: "sha256 digest".to_string(),
        })
}

/// encode H256 to bech32 address
pub fn ripemd160_digest(bz: impl AsRef<[u8]>) -> ChainResult<[u8; 20]> {
    let mut hasher = Ripemd160::new();

    hasher.update(bz);

    hasher
        .finalize()
        .as_slice()
        .try_into()
        .map_err(|_| ChainCommunicationError::ParseError {
            msg: "ripemd160".to_string(),
        })
}

/// encode H256 to bech32 address
pub fn pub_to_addr(pub_key: Vec<u8>, prefix: &str) -> ChainResult<String> {
    let sha_hash = sha256_digest(pub_key)?;
    let rip_hash = ripemd160_digest(sha_hash)?;

    let addr =
        bech32::encode(prefix, rip_hash.to_base32(), bech32::Variant::Bech32).map_err(|_| {
            ChainCommunicationError::ParseError {
                msg: "bech32".to_string(),
            }
        })?;

    Ok(addr)
}
