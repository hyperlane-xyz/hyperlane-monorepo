use hyperlane_core::H256;
use solana_program::program_error::ProgramError;

use crate::multisig::EcdsaSignature;

pub struct MultisigIsmMessageIdMetadata {
    pub origin_mailbox: H256,
    pub merkle_root: H256,
    pub validator_signatures: Vec<EcdsaSignature>,
}

const ORIGIN_MAILBOX_OFFSET: usize = 0;
const MERKLE_ROOT_OFFSET: usize = 32;
const SIGNATURES_OFFSET: usize = 64;
const SIGNATURE_LENGTH: usize = 65;

impl TryFrom<Vec<u8>> for MultisigIsmMessageIdMetadata {
    type Error = ProgramError;

    fn try_from(bytes: Vec<u8>) -> Result<Self, Self::Error> {
        let bytes_len = bytes.len();
        // Require the bytes to be at least big enough to include a single signature.
        if bytes_len < SIGNATURES_OFFSET + SIGNATURE_LENGTH {
            return Err(ProgramError::InvalidArgument);
        }

        let origin_mailbox = H256::from_slice(&bytes[ORIGIN_MAILBOX_OFFSET..MERKLE_ROOT_OFFSET]);
        let merkle_root = H256::from_slice(&bytes[MERKLE_ROOT_OFFSET..SIGNATURES_OFFSET]);

        let signature_bytes_len = bytes_len - SIGNATURES_OFFSET;
        // Require the signature bytes to be a multiple of the signature length.
        // We don't need to check if signature_bytes_len is 0 because this is checked
        // above.
        if signature_bytes_len % SIGNATURE_LENGTH != 0 {
            return Err(ProgramError::InvalidArgument);
        }
        let signature_count = signature_bytes_len / SIGNATURE_LENGTH;
        let mut validator_signatures = Vec::with_capacity(signature_count);
        for i in 0..signature_count {
            let signature_offset = SIGNATURES_OFFSET + (i * SIGNATURE_LENGTH);
            let signature = EcdsaSignature::from_bytes(
                &bytes[signature_offset..signature_offset + SIGNATURE_LENGTH],
            )?;
            validator_signatures.push(signature);
        }

        Ok(Self {
            origin_mailbox,
            merkle_root,
            validator_signatures,
        })
    }
}
