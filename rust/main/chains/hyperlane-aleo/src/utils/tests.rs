use std::str::FromStr;

use snarkvm::prelude::{Address, TestnetV0};

use hyperlane_core::H256;

use crate::{CurrentNetwork, MESSAGE_BODY_U128_WORDS};

use super::*;

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
    let tx_id = get_tx_id::<TestnetV0>(hash).unwrap();

    let bytes = tx_id.to_bytes_le().unwrap();
    assert_eq!(bytes.as_slice(), &[0u8; 32]);
}

#[test]
fn test_to_h256() {
    let address = Address::<CurrentNetwork>::from_str(
        "aleo12tf856xd9we5ay090zkep0s3q5e8srzwqr37ds0ppvv5kkzad5fqvwndmx",
    )
    .unwrap();
    let h256 = to_h256(address).unwrap();

    let expected_bytes =
        hex::decode("52d27a68cd2bb34e91e578ad90be110532780c4e00e3e6c1e10b194b585d6d12").unwrap();
    assert_eq!(h256.as_bytes(), expected_bytes.as_slice());
}

#[test]
fn test_to_h256_with_custom_struct() {
    let test_struct = TestStruct {};
    let h256 = to_h256(test_struct);
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

    let key_id = to_key_id(&program_id, &mapping_name, &key).unwrap();
    let expected_key_id = Field::<CurrentNetwork>::from_str(
        "804856378139656320849856436685808080271884643790236438308126650299339833474field",
    )
    .unwrap();
    assert_eq!(key_id, expected_key_id);
}

#[test]
fn test_h512_to_tx_id_roundtrip() {
    use hyperlane_core::{H256, H512};

    // Create a test H256 hash (Aleo transaction IDs are 32 bytes)
    // Using a deterministic value for reproducible testing
    let original_h256 = H256::from([1u8; 32]);

    // Convert to H512 for storage (as we do in the adapter)
    let h512: H512 = original_h256.into();

    // Convert H512 -> H256 -> TransactionID (as done in get_transaction_status)
    let h256_from_h512: H256 = h512.into();
    let tx_id = get_tx_id::<TestnetV0>(h256_from_h512).unwrap();

    // Convert TransactionID -> H256 (as done in execute method)
    let h256_roundtrip = to_h256(tx_id).unwrap();

    // Verify round-trip preserves the hash
    assert_eq!(
        original_h256, h256_roundtrip,
        "H256 -> H512 -> H256 -> TransactionID -> H256 conversion should preserve the hash"
    );
}

#[test]
fn test_aleo_hash_to_h256() {
    let id = [1u128, 2u128];
    let hash = aleo_hash_to_h256(&id);
    let expected_bytes =
        hex::decode("0100000000000000000000000000000002000000000000000000000000000000").unwrap();
    let expected_hash = H256::from_slice(&expected_bytes);

    assert_eq!(hash, expected_hash);
}

#[test]
fn test_bytes_to_u128_words_empty() {
    let words = bytes_to_u128_words(&[]);
    assert_eq!(words, [0u128; MESSAGE_BODY_U128_WORDS]);
}

#[test]
fn test_bytes_to_u128_words_exact_full() {
    let mut input = Vec::new();
    for i in 0..MESSAGE_BODY_U128_WORDS {
        let word = (i as u128) + 1;
        input.extend_from_slice(&word.to_le_bytes());
    }
    let words = bytes_to_u128_words(&input);
    let expected: [u128; MESSAGE_BODY_U128_WORDS] = core::array::from_fn(|i| (i as u128) + 1);
    assert_eq!(words, expected);
}

#[test]
fn test_bytes_to_u128_words_partial_last_chunk() {
    // First full 16 bytes (word = 1), then a single byte 0xAB for next chunk.
    let mut input = Vec::new();
    input.extend_from_slice(&1u128.to_le_bytes());
    input.push(0xAB);
    let words = bytes_to_u128_words(&input);
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
    let words = bytes_to_u128_words(&input);
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
    let words = bytes_to_u128_words(&first);
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
    let words = bytes_to_u128_words(&input);
    let max = u128::MAX;
    for w in &words {
        assert_eq!(*w, max);
    }
}

#[test]
fn test_pad_to_length_exact_size() {
    let data = vec![1u8, 2, 3, 4];
    let res = pad_to_length::<4>(data, 0xAA);
    assert_eq!(res, [1u8, 2, 3, 4]);
}

#[test]
fn test_pad_to_length_smaller_than_length() {
    let data = vec![0x01, 0x02];
    let res = pad_to_length::<5>(data, 0xFF);
    assert_eq!(res, [0x01, 0x02, 0xFF, 0xFF, 0xFF]);
}

#[test]
fn test_pad_to_length_empty_input() {
    let data = Vec::<u8>::new();
    let res = pad_to_length::<3>(data, 0x00);
    assert_eq!(res, [0x00, 0x00, 0x00]);
}

#[test]
fn test_pad_to_length_truncates_extra_bytes() {
    let data = vec![10u8, 20, 30, 40, 50, 60];
    let res = pad_to_length::<4>(data, 0xEE);
    assert_eq!(res, [10u8, 20, 30, 40]); // last two bytes are truncated
}

#[test]
fn test_pad_to_length_custom_pad_byte() {
    let data = vec![0xAB];
    let res = pad_to_length::<4>(data, 0x7F);
    assert_eq!(res, [0xAB, 0x7F, 0x7F, 0x7F]);
}
