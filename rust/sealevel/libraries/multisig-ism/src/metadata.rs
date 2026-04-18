/// Multisig ISM message-ID metadata format (EVM-compatible):
///
/// [  0: 32] Origin merkle tree hook address
/// [ 32: 64] Merkle root
/// [ 64: 68] Merkle index (u32 BE)
/// [ 68:   ] ECDSA validator signatures (65 bytes each)
use crate::error::MultisigIsmError;
use ecdsa_signature::EcdsaSignature;
use hyperlane_core::{Encode, H256};

const ORIGIN_MAILBOX_OFFSET: usize = 0;
const MERKLE_ROOT_OFFSET: usize = 32;
const MERKLE_INDEX_OFFSET: usize = 64;
const SIGNATURES_OFFSET: usize = 68;
const SIGNATURE_LENGTH: usize = 65;

#[derive(Debug)]
pub struct MultisigIsmMessageIdMetadata {
    pub origin_merkle_tree_hook: H256,
    pub merkle_root: H256,
    pub merkle_index: u32,
    pub validator_signatures: Vec<EcdsaSignature>,
}

impl TryFrom<Vec<u8>> for MultisigIsmMessageIdMetadata {
    type Error = MultisigIsmError;

    fn try_from(bytes: Vec<u8>) -> Result<Self, Self::Error> {
        let bytes_len = bytes.len();
        if bytes_len < SIGNATURES_OFFSET + SIGNATURE_LENGTH {
            return Err(MultisigIsmError::InvalidMetadata);
        }

        let origin_merkle_tree_hook =
            H256::from_slice(&bytes[ORIGIN_MAILBOX_OFFSET..MERKLE_ROOT_OFFSET]);
        let merkle_root = H256::from_slice(&bytes[MERKLE_ROOT_OFFSET..MERKLE_INDEX_OFFSET]);
        let merkle_index = u32::from_be_bytes(
            bytes[MERKLE_INDEX_OFFSET..SIGNATURES_OFFSET]
                .try_into()
                .map_err(|_| MultisigIsmError::InvalidMetadata)?,
        );

        let signature_bytes_len = bytes_len - SIGNATURES_OFFSET;
        if signature_bytes_len % SIGNATURE_LENGTH != 0 {
            return Err(MultisigIsmError::InvalidMetadata);
        }
        let signature_count = signature_bytes_len / SIGNATURE_LENGTH;
        let mut validator_signatures = Vec::with_capacity(signature_count);
        for i in 0..signature_count {
            let offset = SIGNATURES_OFFSET + (i * SIGNATURE_LENGTH);
            let sig = EcdsaSignature::from_bytes(&bytes[offset..offset + SIGNATURE_LENGTH])
                .map_err(|_| MultisigIsmError::InvalidMetadata)?;
            validator_signatures.push(sig);
        }

        Ok(Self {
            origin_merkle_tree_hook,
            merkle_root,
            merkle_index,
            validator_signatures,
        })
    }
}

impl Encode for MultisigIsmMessageIdMetadata {
    fn write_to<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<usize> {
        let mut n = 0;
        n += writer.write(self.origin_merkle_tree_hook.as_ref())?;
        n += writer.write(self.merkle_root.as_ref())?;
        n += writer.write(&self.merkle_index.to_be_bytes())?;
        for sig in &self.validator_signatures {
            n += writer.write(&sig.as_fixed_bytes()[..])?;
        }
        Ok(n)
    }
}
