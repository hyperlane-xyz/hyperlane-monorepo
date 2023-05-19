use solana_program::program_error::ProgramError;
use spl_type_length_value::discriminator::Discriminator;

/// Instructions that a Hyperlane Multisig ISM is expected to process.
/// The first 8 bytes of the encoded instruction is a discriminator that
/// allows programs to implement the required interface.
#[derive(Eq, PartialEq, Debug)]
pub enum MultisigIsmInstruction {
    ValidatorsAndThreshold,
}

/// First 8 bytes of `hash::hashv(&[b"hyperlane-multisig-ism:validators-and-threshold"])`
const VALIDATORS_AND_THRESHOLD_DISCRIMINATOR: [u8; Discriminator::LENGTH] =
    [82, 96, 5, 220, 241, 173, 13, 50];
const VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE: &[u8] = &VALIDATORS_AND_THRESHOLD_DISCRIMINATOR;

// TODO implement hyperlane-core's Encode & Decode?
impl MultisigIsmInstruction {
    pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
        let mut buf = vec![];
        match self {
            MultisigIsmInstruction::ValidatorsAndThreshold => {
                buf.extend_from_slice(&VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE[..]);
            }
        }

        Ok(buf)
    }

    pub fn decode(buf: &[u8]) -> Result<Self, ProgramError> {
        if buf.len() < Discriminator::LENGTH {
            return Err(ProgramError::InvalidInstructionData);
        }
        let (discriminator, _) = buf.split_at(Discriminator::LENGTH);
        match discriminator {
            VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE => Ok(Self::ValidatorsAndThreshold),
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
            &hashv(&[b"hyperlane-multisig-ism:validators-and-threshold"]).to_bytes()
                [..Discriminator::LENGTH],
            VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE,
        );
    }

    #[test]
    fn test_encode_decode_validators_and_threshold_instruction() {
        let instruction = MultisigIsmInstruction::ValidatorsAndThreshold;

        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE,
        );

        let decoded = MultisigIsmInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }
}
