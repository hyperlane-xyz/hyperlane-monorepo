use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::program_error::ProgramError;
use spl_type_length_value::discriminator::{Discriminator, TlvDiscriminator};

/// Instructions that a Hyperlane message recipient is expected to process.
/// The first 8 bytes of the encoded instruction is a discriminator that
/// allows programs to implement the required interface.
#[derive(Eq, PartialEq, Debug)]
pub enum MessageRecipientInstruction {
    InterchainSecurityModule(InterchainSecurityModuleInstruction),
    Handle(HandleInstruction),
}

#[derive(Eq, PartialEq, BorshSerialize, BorshDeserialize, Debug)]
pub struct InterchainSecurityModuleInstruction {
    pub message: Vec<u8>,
}

/// First 8 bytes of `hash::hashv(&[b"hyperlane-message-recipient:interchain-security-module"])`
const INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR: [u8; Discriminator::LENGTH] =
    [45, 18, 245, 87, 234, 46, 246, 15];
const INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR_SLICE: &[u8] =
    &INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR;

impl TlvDiscriminator for InterchainSecurityModuleInstruction {
    const TLV_DISCRIMINATOR: Discriminator =
        Discriminator::new(INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR);
}

#[derive(Eq, PartialEq, BorshSerialize, BorshDeserialize, Debug)]
pub struct HandleInstruction {
    pub metadata: Vec<u8>,
    pub message: Vec<u8>,
}

/// First 8 bytes of `hash::hashv(&[b"hyperlane-message-recipient:handle"])`
const HANDLE_DISCRIMINATOR: [u8; Discriminator::LENGTH] = [33, 210, 5, 66, 196, 212, 239, 142];
const HANDLE_DISCRIMINATOR_SLICE: &[u8] = &HANDLE_DISCRIMINATOR;

impl TlvDiscriminator for HandleInstruction {
    const TLV_DISCRIMINATOR: Discriminator = Discriminator::new(HANDLE_DISCRIMINATOR);
}

impl MessageRecipientInstruction {
    pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
        let mut buf = vec![];
        match self {
            MessageRecipientInstruction::InterchainSecurityModule(instruction) => {
                buf.extend_from_slice(&INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR_SLICE[..]);
                buf.extend_from_slice(
                    &instruction
                        .try_to_vec()
                        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
                );
            }
            MessageRecipientInstruction::Handle(instruction) => {
                buf.extend_from_slice(&HANDLE_DISCRIMINATOR_SLICE[..]);
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
            INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR_SLICE => {
                let instruction = InterchainSecurityModuleInstruction::try_from_slice(rest)
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
                Ok(Self::InterchainSecurityModule(instruction))
            }
            HANDLE_DISCRIMINATOR_SLICE => {
                let instruction = HandleInstruction::try_from_slice(rest)
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
                Ok(Self::Handle(instruction))
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
            &hashv(&[b"hyperlane-message-recipient:interchain-security-module"]).to_bytes()
                [..Discriminator::LENGTH],
            INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR_SLICE,
        );

        assert_eq!(
            &hashv(&[b"hyperlane-message-recipient:handle"]).to_bytes()[..Discriminator::LENGTH],
            HANDLE_DISCRIMINATOR_SLICE,
        );
    }

    #[test]
    fn test_encode_decode_interchain_security_module_instruction() {
        let instruction = MessageRecipientInstruction::InterchainSecurityModule(
            InterchainSecurityModuleInstruction {
                message: vec![1, 2, 3, 4, 5],
            },
        );

        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR_SLICE,
        );

        let decoded = MessageRecipientInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }

    #[test]
    fn test_encode_decode_handle_instruction() {
        let instruction = MessageRecipientInstruction::Handle(HandleInstruction {
            metadata: vec![5, 4, 3, 2, 1],
            message: vec![1, 2, 3, 4, 5],
        });

        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            HANDLE_DISCRIMINATOR_SLICE,
        );

        let decoded = MessageRecipientInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }
}
