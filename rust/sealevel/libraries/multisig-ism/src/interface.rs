use solana_program::program_error::ProgramError;
use spl_type_length_value::discriminator::Discriminator;

/// Instructions that a Hyperlane Multisig ISM is expected to process.
/// The first 8 bytes of the encoded instruction is a discriminator that
/// allows programs to implement the required interface.
#[derive(Eq, PartialEq, Debug)]
pub enum MultisigIsmInstruction {
    /// Gets the validators and threshold for the provided message.
    ValidatorsAndThreshold(Vec<u8>),
    /// Gets the account metas required for an instruction to the
    /// `ValidatorsAndThreshold` program.
    /// Intended to be simulated by an off-chain client.
    /// The only account passed into this instruction is expected to be
    /// the read-only PDA relating to the program ID and the seeds
    /// `VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS`
    ValidatorsAndThresholdAccountMetas(Vec<u8>),
}

/// First 8 bytes of `hash::hashv(&[b"hyperlane-multisig-ism:validators-and-threshold"])`
const VALIDATORS_AND_THRESHOLD_DISCRIMINATOR: [u8; Discriminator::LENGTH] =
    [82, 96, 5, 220, 241, 173, 13, 50];
const VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE: &[u8] = &VALIDATORS_AND_THRESHOLD_DISCRIMINATOR;

const VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR: [u8; Discriminator::LENGTH] =
    [113, 7, 132, 85, 239, 247, 157, 204];
const VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR_SLICE: &[u8] =
    &VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR;

/// Seeds for the PDA that's expected to be passed into the `ValidatorsAndThresholdAccountMetas`
/// instruction.
pub const VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS: &[&[u8]] = &[
    b"hyperlane_multisig_ism",
    b"-",
    b"validators_and_threshold",
    b"-",
    b"account_metas",
];

impl MultisigIsmInstruction {
    pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
        let mut buf = vec![];
        match self {
            MultisigIsmInstruction::ValidatorsAndThreshold(message) => {
                buf.extend_from_slice(VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE);
                buf.extend_from_slice(&message[..]);
            }
            MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas(message) => {
                buf.extend_from_slice(VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR_SLICE);
                buf.extend_from_slice(&message[..]);
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
            VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE => {
                let message = rest.to_vec();
                Ok(Self::ValidatorsAndThreshold(message))
            }
            VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR_SLICE => {
                let message = rest.to_vec();
                Ok(Self::ValidatorsAndThresholdAccountMetas(message))
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
            &hashv(&[b"hyperlane-multisig-ism:validators-and-threshold"]).to_bytes()
                [..Discriminator::LENGTH],
            VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE,
        );

        assert_eq!(
            &hashv(&[b"hyperlane-multisig-ism:validators-and-threshold-account-metas"]).to_bytes()
                [..Discriminator::LENGTH],
            VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR_SLICE,
        );
    }

    #[test]
    fn test_encode_decode_validators_and_threshold_instruction() {
        let instruction = MultisigIsmInstruction::ValidatorsAndThreshold(vec![1, 2, 3, 4, 5]);

        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE,
        );

        let decoded = MultisigIsmInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }

    #[test]
    fn test_encode_decode_validators_and_threshold_account_metas_instruction() {
        let instruction =
            MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas(vec![1, 2, 3, 4, 5]);

        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR_SLICE,
        );

        let decoded = MultisigIsmInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }
}
