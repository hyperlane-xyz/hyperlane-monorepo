use hyperlane_core::{ChainResult, H256};
use snarkvm::prelude::{Identifier, Network, Plaintext, ProgramID};
use snarkvm_console_account::{Field, FromBytes, Itertools, ToBits, ToBytes};

use crate::{HyperlaneAleoError, TxID};

/// Converts a [U128; 2] into a H256
pub(crate) fn u128_to_hash(id: &[u128; 2]) -> H256 {
    let bytes = id
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect_vec();
    H256::from_slice(&bytes)
}

/// Converts a H256 into [U128; 2]
pub(crate) fn hash_to_u128(id: &H256) -> ChainResult<[u128; 2]> {
    let first = &id.as_fixed_bytes()[..16];
    let second = &id.as_fixed_bytes()[16..];
    return Ok([
        u128::from_bytes_le(first).map_err(HyperlaneAleoError::from)?,
        u128::from_bytes_le(second).map_err(HyperlaneAleoError::from)?,
    ]);
}

/// Convert a H256 into a TxID
pub(crate) fn get_tx_id(hash: impl Into<H256>) -> ChainResult<TxID> {
    Ok(TxID::from_bytes_le(hash.into().as_bytes()).map_err(HyperlaneAleoError::from)?)
}

/// Convert a TxID or any other struct that implements ToBytes to H256
pub(crate) fn to_h256<T: ToBytes>(id: T) -> ChainResult<H256> {
    let bytes = id.to_bytes_le().map_err(HyperlaneAleoError::from)?;
    Ok(H256::from_slice(&bytes))
}

/// Returns the key ID for the given `program ID`, `mapping name`, and `key`.
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

/// Macro: serialize any number of arguments into a Vec<Plaintext<CurrentNetwork>>.
/// Each argument is passed by reference to AleoSerialize<CurrentNetwork>::to_plaintext.
/// Returns ChainResult<Vec<Plaintext<CurrentNetwork>>> so it can use `?` at call sites.
#[macro_export]
macro_rules! aleo_args {
    ($($arg:expr),* $(,)?) => {{
        let mut out = Vec::new();
        $(
            out.push(aleo_serialize::AleoSerialize::<$crate::CurrentNetwork>::to_plaintext(&$arg).map_err($crate::HyperlaneAleoError::from)?.to_string());
        )*
        ::hyperlane_core::ChainResult::Ok(out)
    }};
}
