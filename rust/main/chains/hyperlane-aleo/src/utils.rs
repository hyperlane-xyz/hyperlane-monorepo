use hyperlane_core::{ChainResult, H256};
use snarkvm::prelude::{Identifier, Network, Plaintext, ProgramID};
use snarkvm_console_account::{Field, FromBytes, Itertools, ToBits, ToBytes};

use crate::{AleoHash, HyperlaneAleoError, MESSAGE_BODY_U128_WORDS};

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
mod tests {
    use std::str::FromStr;

    use snarkvm::prelude::TestnetV0;
    use snarkvm_console_account::Address;

    use super::*;
    use crate::{CurrentNetwork, MESSAGE_BODY_U128_WORDS};

    struct TestStruct {}

    impl ToBytes for TestStruct {
        fn write_le<W: std::io::Write>(&self, writer: W) -> std::io::Result<()>
        where
            Self: Sized,
        {
            [0u8; 33].write_le(writer)
        }
    }

    #[test]
    fn test_get_tx_id() {
        let hash = H256::zero();
        let tx_id = super::get_tx_id::<TestnetV0>(hash).unwrap();

        let bytes = tx_id.to_bytes_le().unwrap();
        assert_eq!(bytes.as_slice(), &[0u8; 32]);
    }

    #[test]
    fn test_to_h256() {
        let address = Address::<CurrentNetwork>::from_str(
            "aleo12tf856xd9we5ay090zkep0s3q5e8srzwqr37ds0ppvv5kkzad5fqvwndmx",
        )
        .unwrap();
        let h256 = super::to_h256(address).unwrap();

        let expected_bytes =
            hex::decode("52d27a68cd2bb34e91e578ad90be110532780c4e00e3e6c1e10b194b585d6d12")
                .unwrap();
        assert_eq!(h256.as_bytes(), expected_bytes.as_slice());
    }

    #[test]
    fn test_to_h256_with_custom_struct() {
        let test_struct = TestStruct {};
        let h256 = super::to_h256(test_struct);
        assert!(h256.is_err());
        assert_eq!(
            h256.err().unwrap().to_string(),
            "Invalid length for H256 conversion: expected 32, got 33"
        );
    }

    #[test]
    fn test_to_key_id() {
        let program_id = ProgramID::<CurrentNetwork>::from_str("aleo_program.aleo").unwrap();
        let mapping_name = Identifier::<CurrentNetwork>::from_str("my_mapping").unwrap();
        let key = Plaintext::<CurrentNetwork>::from_str("42u64").unwrap();

        let key_id = super::to_key_id(&program_id, &mapping_name, &key).unwrap();
        let expected_key_id = Field::<CurrentNetwork>::from_str(
            "804856378139656320849856436685808080271884643790236438308126650299339833474field",
        )
        .unwrap();
        assert_eq!(key_id, expected_key_id);
    }

    #[test]
    fn test_aleo_hash_to_h256() {
        let id = [1u128, 2u128];
        let hash = super::aleo_hash_to_h256(&id);
        let expected_bytes =
            hex::decode("0100000000000000000000000000000002000000000000000000000000000000")
                .unwrap();
        let expected_hash = H256::from_slice(&expected_bytes);

        assert_eq!(hash, expected_hash);
    }

    #[test]
    fn test_bytes_to_u128_words_empty() {
        let words = super::bytes_to_u128_words(&[]);
        assert_eq!(words, [0u128; MESSAGE_BODY_U128_WORDS]);
    }

    #[test]
    fn test_bytes_to_u128_words_exact_full() {
        let mut input = Vec::new();
        for i in 0..MESSAGE_BODY_U128_WORDS {
            let word = (i as u128) + 1;
            input.extend_from_slice(&word.to_le_bytes());
        }
        let words = super::bytes_to_u128_words(&input);
        let expected: [u128; MESSAGE_BODY_U128_WORDS] = core::array::from_fn(|i| (i as u128) + 1);
        assert_eq!(words, expected);
    }

    #[test]
    fn test_bytes_to_u128_words_partial_last_chunk() {
        // First full 16 bytes (word = 1), then a single byte 0xAB for next chunk.
        let mut input = Vec::new();
        input.extend_from_slice(&1u128.to_le_bytes());
        input.push(0xAB);
        let words = super::bytes_to_u128_words(&input);
        assert_eq!(words[0], 1u128);
        assert_eq!(words[1], 0xABu128);
        for w in &words[2..] {
            assert_eq!(*w, 0u128);
        }
    }

    #[test]
    fn test_bytes_to_u128_words_ignores_extra() {
        // Provide more than 16*16 bytes; only first 16 words should be used.
        let mut input = Vec::new();
        for i in 0..(MESSAGE_BODY_U128_WORDS + 4) {
            input.extend_from_slice(&(i as u128).to_le_bytes());
        }
        let words = super::bytes_to_u128_words(&input);
        let expected: [u128; MESSAGE_BODY_U128_WORDS] = core::array::from_fn(|i| i as u128);
        assert_eq!(words, expected);
    }

    #[test]
    fn test_bytes_to_u128_words_endianness() {
        // Construct first 16-byte chunk with ascending bytes 1..=16, rest zero.
        let mut first = [0u8; 16];
        for i in 0..16 {
            first[i] = (i as u8) + 1;
        }
        let words = super::bytes_to_u128_words(&first);
        let expected_first = u128::from_le_bytes(first);
        assert_eq!(words[0], expected_first);
        for w in &words[1..] {
            assert_eq!(*w, 0u128);
        }
    }

    #[test]
    fn test_bytes_to_u128_words_max_value_chunks() {
        // Fill each chunk with 0xFF to ensure proper max u128 value handling.
        let mut input = Vec::new();
        for _ in 0..MESSAGE_BODY_U128_WORDS {
            input.extend_from_slice(&[0xFFu8; 16]);
        }
        let words = super::bytes_to_u128_words(&input);
        let max = u128::MAX;
        for w in &words {
            assert_eq!(*w, max);
        }
    }
}
