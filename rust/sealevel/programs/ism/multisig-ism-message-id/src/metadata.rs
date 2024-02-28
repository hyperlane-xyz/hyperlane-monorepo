use ecdsa_signature::EcdsaSignature;
use hyperlane_core::{Encode, H256};

use crate::error::Error;

#[derive(Debug)]
pub struct MultisigIsmMessageIdMetadata {
    pub origin_merkle_tree_hook: H256,
    pub merkle_root: H256,
    pub merkle_index: u32,
    pub validator_signatures: Vec<EcdsaSignature>,
}

const ORIGIN_MAILBOX_OFFSET: usize = 0;
const MERKLE_ROOT_OFFSET: usize = 32;
const MERKLE_INDEX_OFFSET: usize = 64;
const SIGNATURES_OFFSET: usize = 68;
const SIGNATURE_LENGTH: usize = 65;

/// Format of metadata:
/// [   0:  32] Origin mailbox address
/// [  32:  64] Merkle root
/// [  64:????] Validator signatures (length := threshold)
/// Note that the validator signatures being the length of the threshold is
/// not enforced here and should be enforced by the caller.
impl TryFrom<Vec<u8>> for MultisigIsmMessageIdMetadata {
    type Error = Error;

    fn try_from(bytes: Vec<u8>) -> Result<Self, Self::Error> {
        let bytes_len = bytes.len();
        // Require the bytes to be at least big enough to include a single signature.
        if bytes_len < SIGNATURES_OFFSET + SIGNATURE_LENGTH {
            return Err(Error::InvalidMetadata);
        }

        let origin_mailbox = H256::from_slice(&bytes[ORIGIN_MAILBOX_OFFSET..MERKLE_ROOT_OFFSET]);
        let merkle_root = H256::from_slice(&bytes[MERKLE_ROOT_OFFSET..MERKLE_INDEX_OFFSET]);
        // This cannot panic since SIGNATURES_OFFSET - MERKLE_INDEX_OFFSET is 4.
        let merkle_index_bytes: [u8; 4] = bytes[MERKLE_INDEX_OFFSET..SIGNATURES_OFFSET]
            .try_into()
            .map_err(|_| Error::InvalidMetadata)?;
        let merkle_index = u32::from_be_bytes(merkle_index_bytes);

        let signature_bytes_len = bytes_len - SIGNATURES_OFFSET;
        // Require the signature bytes to be a multiple of the signature length.
        // We don't need to check if signature_bytes_len is 0 because this is checked
        // above.
        if signature_bytes_len % SIGNATURE_LENGTH != 0 {
            return Err(Error::InvalidMetadata);
        }
        let signature_count = signature_bytes_len / SIGNATURE_LENGTH;
        let mut validator_signatures = Vec::with_capacity(signature_count);
        for i in 0..signature_count {
            let signature_offset = SIGNATURES_OFFSET + (i * SIGNATURE_LENGTH);
            let signature = EcdsaSignature::from_bytes(
                &bytes[signature_offset..signature_offset + SIGNATURE_LENGTH],
            )
            .map_err(|_| Error::InvalidMetadata)?;
            validator_signatures.push(signature);
        }

        Ok(Self {
            origin_merkle_tree_hook: origin_mailbox,
            merkle_root,
            merkle_index,
            validator_signatures,
        })
    }
}

impl Encode for MultisigIsmMessageIdMetadata {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut bytes_written = 0;
        bytes_written += writer.write(self.origin_merkle_tree_hook.as_ref())?;
        bytes_written += writer.write(self.merkle_root.as_ref())?;
        bytes_written += writer.write(&self.merkle_index.to_be_bytes())?;
        for signature in &self.validator_signatures {
            bytes_written += writer.write(&signature.as_fixed_bytes()[..])?;
        }
        Ok(bytes_written)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use rand::Rng;

    // Provide a default test implementation
    fn dummy_metadata_with_sigs(sigs: Vec<EcdsaSignature>) -> MultisigIsmMessageIdMetadata {
        let mut rng = rand::thread_rng();
        MultisigIsmMessageIdMetadata {
            origin_merkle_tree_hook: H256::random(),
            merkle_root: H256::random(),
            merkle_index: rng.gen(),
            validator_signatures: sigs,
        }
    }

    #[test]
    fn test_decode_correctly_formatted_metadata() {
        let validator_signatures = vec![
            EcdsaSignature {
                serialized_rs: [11u8; 64],
                recovery_id: 0,
            },
            EcdsaSignature {
                serialized_rs: [12u8; 64],
                recovery_id: 1,
            },
            EcdsaSignature {
                serialized_rs: [13u8; 64],
                recovery_id: 0,
            },
        ];
        let test_meta = dummy_metadata_with_sigs(validator_signatures);
        let encoded_meta = test_meta.to_vec();
        let metadata = MultisigIsmMessageIdMetadata::try_from(encoded_meta.clone()).unwrap();
        assert_eq!(
            metadata.origin_merkle_tree_hook,
            test_meta.origin_merkle_tree_hook
        );
        assert_eq!(metadata.merkle_root, test_meta.merkle_root);
        assert_eq!(metadata.merkle_index, test_meta.merkle_index);
        assert_eq!(
            metadata.validator_signatures,
            test_meta.validator_signatures
        );
    }

    #[test]
    fn test_decode_no_signatures_is_err() {
        let test_meta = dummy_metadata_with_sigs(vec![]);
        let encoded_meta = test_meta.to_vec();
        let result = MultisigIsmMessageIdMetadata::try_from(encoded_meta);
        assert!(result.unwrap_err() == Error::InvalidMetadata);
    }

    #[test]
    fn test_decode_incorrect_signature_length_is_err() {
        let sigs = vec![EcdsaSignature {
            serialized_rs: [1u8; 64],
            recovery_id: 0,
        }];
        let test_meta = dummy_metadata_with_sigs(sigs);
        let encoded_meta = test_meta.to_vec();
        // remove the last byte from the encoded signature
        let faulty_encoded_meta = encoded_meta[..encoded_meta.len() - 1].to_vec();
        let result = MultisigIsmMessageIdMetadata::try_from(faulty_encoded_meta);
        assert!(result.unwrap_err() == Error::InvalidMetadata);
        MultisigIsmMessageIdMetadata::try_from(encoded_meta).expect("Decoding should succeed");
    }

    #[test]
    fn test_decode_real_meta() {
        // multisig ism message id metadata from this tx:
        // https://arbiscan.io//tx/0xe558f04ad446b1d9ec4d4a1284661869b73daff38ec9fb7e809be652732fff30#txninfo
        let bytes = hex::decode("000000000000000000000000149db7afd694722747035d5aec7007ccb6f8f112fb91807ccda2db543bfbd013242643553bc1238f891ae9d0abb3b8b46c5a89990000017addc429c97ca8bcd6ad86ef4461379374b0d545308a1f47db246a6c028f74d7af521dd9355afd2f2a02565a24f22ac7b7e388cbd1f2a931acc97ce689be5456851b4d22f1aece05d293e574e38edcda9f2db64f1dc5b69a89a6a5989e7aaa4f443c137e593bb794eb211de719ed0f466a0778c4d204cc275f54c0936eee918ae1651c").unwrap();
        MultisigIsmMessageIdMetadata::try_from(bytes).expect("Decoding should succeed");
    }
}
