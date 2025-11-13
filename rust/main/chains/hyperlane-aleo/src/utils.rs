use hyperlane_core::{ChainResult, H256};
use snarkvm::prelude::{Identifier, Network, Plaintext, ProgramID};
use snarkvm_console_account::{Field, FromBytes, Itertools, ToBits, ToBytes};

use crate::{AleoHash, HyperlaneAleoError, TxID};

/// Converts a AleoHash/[U128; 2] into a H256
/// Uses little-endian byte order
pub(crate) fn aleo_hash_to_h256(id: &AleoHash) -> H256 {
    let bytes = id
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect_vec();
    H256::from_slice(&bytes)
}

/// Convert a H256 into a TxID
pub(crate) fn get_tx_id(hash: impl Into<H256>) -> ChainResult<TxID> {
    Ok(TxID::from_bytes_le(hash.into().as_bytes()).map_err(HyperlaneAleoError::from)?)
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

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use snarkvm_console_account::Address;

    use super::*;
    use crate::CurrentNetwork;

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
        let tx_id = super::get_tx_id(hash).unwrap();

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
    fn test_u128_to_hash() {
        let id = [1u128, 2u128];
        let hash = super::aleo_hash_to_h256(&id);
        let expected_bytes =
            hex::decode("0100000000000000000000000000000002000000000000000000000000000000")
                .unwrap();
        let expected_hash = H256::from_slice(&expected_bytes);

        assert_eq!(hash, expected_hash);
    }
}
