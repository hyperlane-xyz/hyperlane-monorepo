use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::program_error::ProgramError;
use spl_type_length_value::discriminator::{Discriminator, TlvDiscriminator};

/// Instructions that a Hyperlane interchain security module is expected to process.
/// The first 8 bytes of the encoded instruction is a discriminator that
/// allows programs to implement the required interface.
#[derive(Eq, PartialEq, Debug)]
pub enum InterchainSecurityModuleInstruction {
    Type,
    Verify(VerifyInstruction),
}

/// First 8 bytes of `hash::hashv(&[b"hyperlane-interchain-security-module:type"])`
const TYPE_DISCRIMINATOR: [u8; Discriminator::LENGTH] = [105, 97, 97, 88, 63, 124, 106, 18];
const TYPE_DISCRIMINATOR_SLICE: &[u8] = &TYPE_DISCRIMINATOR;

#[derive(Eq, PartialEq, BorshSerialize, BorshDeserialize, Debug)]
pub struct VerifyInstruction {
    pub metadata: Vec<u8>,
    pub message: Vec<u8>,
}

impl VerifyInstruction {
    pub fn new(metadata: Vec<u8>, message: Vec<u8>) -> Self {
        Self { metadata, message }
    }
}

/// First 8 bytes of `hash::hashv(&[b"hyperlane-interchain-security-module:verify"])`
const VERIFY_DISCRIMINATOR: [u8; Discriminator::LENGTH] = [243, 53, 214, 0, 208, 18, 231, 67];
const VERIFY_DISCRIMINATOR_SLICE: &[u8] = &VERIFY_DISCRIMINATOR;

// TODO: does this even need to be implemented?
impl TlvDiscriminator for VerifyInstruction {
    const TLV_DISCRIMINATOR: Discriminator = Discriminator::new(VERIFY_DISCRIMINATOR);
}

// TODO implement hyperlane-core's Encode & Decode?
impl InterchainSecurityModuleInstruction {
    pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
        let mut buf = vec![];
        match self {
            InterchainSecurityModuleInstruction::Type => {
                buf.extend_from_slice(&TYPE_DISCRIMINATOR_SLICE[..]);
            }
            InterchainSecurityModuleInstruction::Verify(instruction) => {
                buf.extend_from_slice(&VERIFY_DISCRIMINATOR_SLICE[..]);
                buf.extend_from_slice(
                    &instruction
                        .try_to_vec()
                        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
                );
            }
        }

        Ok(buf)
    }

    pub fn decode(buf: &[u8]) -> Result<Self, ProgramError> {
        if buf.len() < Discriminator::LENGTH {
            return Err(ProgramError::InvalidInstructionData);
        }
        let (discriminator, rest) = buf.split_at(Discriminator::LENGTH);
        match discriminator {
            TYPE_DISCRIMINATOR_SLICE => Ok(Self::Type),
            VERIFY_DISCRIMINATOR_SLICE => {
                let instruction = VerifyInstruction::try_from_slice(rest)
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
                Ok(Self::Verify(instruction))
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use solana_program::hash::hashv;

    #[test]
    fn test_discriminator_slices() {
        assert_eq!(
            &hashv(&[b"hyperlane-interchain-security-module:type"]).to_bytes()
                [..Discriminator::LENGTH],
            TYPE_DISCRIMINATOR_SLICE,
        );

        assert_eq!(
            &hashv(&[b"hyperlane-interchain-security-module:verify"]).to_bytes()
                [..Discriminator::LENGTH],
            VERIFY_DISCRIMINATOR_SLICE,
        );
    }

    #[test]
    fn test_encode_decode_type_instruction() {
        let instruction = InterchainSecurityModuleInstruction::Type;

        let encoded = instruction.encode().unwrap();
        assert_eq!(&encoded[..Discriminator::LENGTH], TYPE_DISCRIMINATOR_SLICE,);

        let decoded = InterchainSecurityModuleInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }

    #[test]
    fn test_encode_decode_verify_instruction() {
        let instruction = InterchainSecurityModuleInstruction::Verify(VerifyInstruction::new(
            vec![5, 4, 3, 2, 1],
            vec![1, 2, 3, 4, 5],
        ));

        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            VERIFY_DISCRIMINATOR_SLICE,
        );

        let decoded = InterchainSecurityModuleInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }
}
