use std::str::FromStr;

use solana_sdk::bs58;
use solana_sdk::pubkey::Pubkey;

use hyperlane_core::{H256, H512};

use crate::error::HyperlaneSealevelError;

pub fn from_base58(base58: &str) -> Result<Vec<u8>, HyperlaneSealevelError> {
    let binary = bs58::decode(base58)
        .into_vec()
        .map_err(HyperlaneSealevelError::Decoding)?;
    Ok(binary)
}

pub fn decode_h256(base58: &str) -> Result<H256, HyperlaneSealevelError> {
    let binary = from_base58(base58)?;
    let hash = H256::from_slice(&binary);

    Ok(hash)
}

pub fn decode_h512(base58: &str) -> Result<H512, HyperlaneSealevelError> {
    let binary = from_base58(base58)?;
    let hash = H512::from_slice(&binary);

    Ok(hash)
}

pub fn decode_pubkey(address: &str) -> Result<Pubkey, HyperlaneSealevelError> {
    Pubkey::from_str(address).map_err(Into::<HyperlaneSealevelError>::into)
}
