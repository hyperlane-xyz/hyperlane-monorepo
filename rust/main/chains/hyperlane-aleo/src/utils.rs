use hyperlane_core::{ChainResult, H256};
use snarkvm::prelude::{Identifier, Network, Plaintext, ProgramID};
use snarkvm_console_account::{Field, FromBytes, Itertools, ToBits, ToBytes};

use crate::{AleoHash, HyperlaneAleoError, MESSAGE_BODY_U128_WORDS};

/// Padding utility function
pub(crate) fn pad_to_length<const LENGTH: usize>(data: Vec<u8>, pad_byte: u8) -> [u8; LENGTH] {
    let copy_len = core::cmp::min(data.len(), LENGTH);
    let mut buf = [pad_byte; LENGTH];
    buf[..copy_len].copy_from_slice(&data[..copy_len]);
    buf
}

/// Converts a AleoHash/[U128; 2] into a H256
/// Uses little-endian byte order
pub(crate) fn aleo_hash_to_h256(id: &AleoHash) -> H256 {
    let bytes = id
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect_vec();
    H256::from_slice(&bytes)
}

/// Converts a H256 into an AleoHash [U128; 2]
pub(crate) fn hash_to_aleo_hash(id: &H256) -> ChainResult<AleoHash> {
    let first = &id.as_fixed_bytes()[..16];
    let second = &id.as_fixed_bytes()[16..];
    Ok([
        u128::from_bytes_le(first).map_err(HyperlaneAleoError::from)?,
        u128::from_bytes_le(second).map_err(HyperlaneAleoError::from)?,
    ])
}

/// Convert a H256 into a TxID
pub(crate) fn get_tx_id<N: Network>(hash: impl Into<H256>) -> ChainResult<N::TransactionID> {
    Ok(
        N::TransactionID::from_bytes_le(hash.into().as_bytes())
            .map_err(HyperlaneAleoError::from)?,
    )
}

/// Convert a TxID or any other struct that implements ToBytes to H256
pub(crate) fn to_h256<T: ToBytes>(id: T) -> ChainResult<H256> {
    let bytes = id.to_bytes_le().map_err(HyperlaneAleoError::from)?;
    if bytes.len() != 32 {
        return Err(hyperlane_core::ChainCommunicationError::from_other_str(
            &format! {"Invalid length for H256 conversion: expected 32, got {}", bytes.len()},
        ));
    }
    Ok(H256::from_slice(&bytes))
}

/// Returns the key ID for the given `program ID`, `mapping name`, and `key`.
/// Copied from snarkVM's internal implementation of mapping key hashing.
/// See: https://github.com/ProvableHQ/snarkVM/blob/6bec0e0e165f7604afa69bce0fc383d50bed9577/ledger/store/src/program/finalize.rs#L46
pub(crate) fn to_key_id<N: Network>(
    program_id: &ProgramID<N>,
    mapping_name: &Identifier<N>,
    key: &Plaintext<N>,
) -> ChainResult<Field<N>> {
    // Construct the preimage.
    let mut preimage = Vec::new();
    program_id.write_bits_le(&mut preimage);
    false.write_bits_le(&mut preimage); // Separator
    mapping_name.write_bits_le(&mut preimage);
    false.write_bits_le(&mut preimage); // Separator
    key.write_bits_le(&mut preimage);
    // Compute the key ID.
    Ok(N::hash_bhp1024(&preimage).map_err(HyperlaneAleoError::from)?)
}

/// Converts a byte slice into an array of 16 little-endian u128 words.
pub(crate) fn bytes_to_u128_words(bytes: &[u8]) -> [u128; 16] {
    let mut words = [0u128; MESSAGE_BODY_U128_WORDS];
    for (i, chunk) in bytes.chunks(16).take(MESSAGE_BODY_U128_WORDS).enumerate() {
        let mut buf = [0u8; 16];
        buf[..chunk.len()].copy_from_slice(chunk);
        words[i] = u128::from_le_bytes(buf);
    }
    words
}

/// Macro: serialize any number of arguments into a Vec<String>.
/// Each argument is passed by reference to AleoSerialize<CurrentNetwork>::to_plaintext.
/// Returns ChainResult<Vec<String>> so it can use `?` at call sites.
#[macro_export]
macro_rules! aleo_args {
    ($($arg:expr),* $(,)?) => {{
        ::hyperlane_core::ChainResult::Ok(vec![
            $(
                aleo_serialize::AleoSerialize::<$crate::CurrentNetwork>::to_plaintext(&$arg)
                    .map_err($crate::HyperlaneAleoError::from)?
                    .to_string()
            ),*
        ])
    }}
}

#[cfg(test)]
mod tests;
