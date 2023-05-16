use hyperlane_core::H256;
use multisig_ism::signature::EcdsaSignature;

use crate::error::Error;

#[derive(Debug)]
pub struct MultisigIsmMessageIdMetadata {
    pub origin_mailbox: H256,
    pub merkle_root: H256,
    pub validator_signatures: Vec<EcdsaSignature>,
}

const ORIGIN_MAILBOX_OFFSET: usize = 0;
const MERKLE_ROOT_OFFSET: usize = 32;
const SIGNATURES_OFFSET: usize = 64;
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
        let merkle_root = H256::from_slice(&bytes[MERKLE_ROOT_OFFSET..SIGNATURES_OFFSET]);

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
            origin_mailbox,
            merkle_root,
            validator_signatures,
        })
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_decode_correctly_formatted_metadata() {
        let origin_mailbox = H256::random();
        let merkle_root = H256::random();
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
        let mut metadata_bytes = origin_mailbox.as_bytes().to_vec();
        metadata_bytes.extend_from_slice(merkle_root.as_bytes());
        for signature in &validator_signatures {
            metadata_bytes.extend_from_slice(&signature.as_bytes()[..]);
        }

        let metadata = MultisigIsmMessageIdMetadata::try_from(metadata_bytes).unwrap();
        assert_eq!(metadata.origin_mailbox, origin_mailbox);
        assert_eq!(metadata.merkle_root, merkle_root);
        assert_eq!(metadata.validator_signatures, validator_signatures);
    }

    #[test]
    fn test_decode_no_signatures_is_err() {
        let origin_mailbox = H256::random();
        let merkle_root = H256::random();
        let metadata_bytes = origin_mailbox
            .as_bytes()
            .iter()
            .chain(merkle_root.as_bytes().iter())
            .cloned()
            .collect::<Vec<u8>>();

        let result = MultisigIsmMessageIdMetadata::try_from(metadata_bytes);
        assert!(result.unwrap_err() == Error::InvalidMetadata);
    }

    #[test]
    fn test_decode_incorrect_signature_length_is_err() {
        let origin_mailbox = H256::random();
        let merkle_root = H256::random();
        let mut metadata_bytes = origin_mailbox.as_bytes().to_vec();
        metadata_bytes.extend_from_slice(merkle_root.as_bytes());
        // 64 byte signature instead of 65.
        metadata_bytes.extend_from_slice(&[1u8; 64]);

        let result = MultisigIsmMessageIdMetadata::try_from(metadata_bytes);
        assert!(result.unwrap_err() == Error::InvalidMetadata);
    }
}
