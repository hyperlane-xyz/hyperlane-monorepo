use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use solana_program::program_error::ProgramError;
use spl_type_length_value::discriminator::Discriminator;

/// Instructions that a Hyperlane message recipient is expected to process.
/// The first 8 bytes of the encoded instruction is a discriminator that
/// allows programs to implement the required interface.
#[derive(Eq, PartialEq, Debug)]
pub enum MessageRecipientInstruction {
    /// Gets the ISM that should verify the message.
    InterchainSecurityModule,
    /// Gets the account metas required for the `InterchainSecurityModule` instruction.
    /// Intended to be simulated by an off-chain client.
    /// The only account passed into this instruction is expected to be
    /// the read-only PDA relating to the program ID and the seeds
    /// `INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS`
    InterchainSecurityModuleAccountMetas,
    /// Handles a message from the Mailbox.
    Handle(HandleInstruction),
    /// Gets the account metas required for the `Handle` instruction.
    /// Intended to be simulated by an off-chain client.
    /// The only account passed into this instruction is expected to be
    /// the read-only PDA relating to the program ID and the seeds
    /// `HANDLE_ACCOUNT_METAS_PDA_SEEDS`
    HandleAccountMetas(HandleInstruction),
}

/// First 8 bytes of `hash::hashv(&[b"hyperlane-message-recipient:interchain-security-module"])`
const INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR: [u8; Discriminator::LENGTH] =
    [45, 18, 245, 87, 234, 46, 246, 15];
const INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR_SLICE: &[u8] =
    &INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR;

/// First 8 bytes of `hash::hashv(&[b"hyperlane-message-recipient:interchain-security-module-account-metas"])`
const INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR: [u8; Discriminator::LENGTH] =
    [190, 214, 218, 129, 67, 97, 4, 76];
const INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR_SLICE: &[u8] =
    &INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR;

/// Seeds for the PDA that's expected to be passed into the `InterchainSecurityModuleAccountMetas`
/// instruction.
pub const INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS: &[&[u8]] = &[
    b"hyperlane_message_recipient",
    b"-",
    b"interchain_security_module",
    b"-",
    b"account_metas",
];

#[derive(Eq, PartialEq, BorshSerialize, BorshDeserialize, Debug)]
pub struct HandleInstruction {
    pub origin: u32,
    pub sender: H256,
    pub message: Vec<u8>,
}

impl HandleInstruction {
    pub fn new(origin: u32, sender: H256, message: Vec<u8>) -> Self {
        Self {
            origin,
            sender,
            message,
        }
    }
}

/// First 8 bytes of `hash::hashv(&[b"hyperlane-message-recipient:handle"])`
const HANDLE_DISCRIMINATOR: [u8; Discriminator::LENGTH] = [33, 210, 5, 66, 196, 212, 239, 142];
const HANDLE_DISCRIMINATOR_SLICE: &[u8] = &HANDLE_DISCRIMINATOR;

/// First 8 bytes of `hash::hashv(&[b"hyperlane-message-recipient:handle-account-metas"])`
const HANDLE_ACCOUNT_METAS_DISCRIMINATOR: [u8; Discriminator::LENGTH] =
    [194, 141, 30, 82, 241, 41, 169, 52];
const HANDLE_ACCOUNT_METAS_DISCRIMINATOR_SLICE: &[u8] = &HANDLE_ACCOUNT_METAS_DISCRIMINATOR;

/// Seeds for the PDA that's expected to be passed into the `HandleAccountMetas`
/// instruction.
pub const HANDLE_ACCOUNT_METAS_PDA_SEEDS: &[&[u8]] = &[
    b"hyperlane_message_recipient",
    b"-",
    b"handle",
    b"-",
    b"account_metas",
];

impl MessageRecipientInstruction {
    pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
        let mut buf = vec![];
        match self {
            MessageRecipientInstruction::InterchainSecurityModule => {
                buf.extend_from_slice(INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR_SLICE);
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                buf.extend_from_slice(INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR_SLICE);
            }
            MessageRecipientInstruction::Handle(instruction) => {
                buf.extend_from_slice(HANDLE_DISCRIMINATOR_SLICE);
                buf.extend_from_slice(
                    &instruction
                        .try_to_vec()
                        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
                );
            }
            MessageRecipientInstruction::HandleAccountMetas(instruction) => {
                buf.extend_from_slice(HANDLE_ACCOUNT_METAS_DISCRIMINATOR_SLICE);
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
            INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR_SLICE => Ok(Self::InterchainSecurityModule),
            INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR_SLICE => {
                Ok(Self::InterchainSecurityModuleAccountMetas)
            }
            HANDLE_DISCRIMINATOR_SLICE => {
                let instruction = HandleInstruction::try_from_slice(rest)
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
                Ok(Self::Handle(instruction))
            }
            HANDLE_ACCOUNT_METAS_DISCRIMINATOR_SLICE => {
                let instruction = HandleInstruction::try_from_slice(rest)
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
                Ok(Self::HandleAccountMetas(instruction))
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
            &hashv(&[b"hyperlane-message-recipient:interchain-security-module-account-metas"])
                .to_bytes()[..Discriminator::LENGTH],
            INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR_SLICE,
        );

        assert_eq!(
            &hashv(&[b"hyperlane-message-recipient:handle"]).to_bytes()[..Discriminator::LENGTH],
            HANDLE_DISCRIMINATOR_SLICE,
        );

        assert_eq!(
            &hashv(&[b"hyperlane-message-recipient:handle-account-metas"]).to_bytes()
                [..Discriminator::LENGTH],
            HANDLE_ACCOUNT_METAS_DISCRIMINATOR_SLICE,
        );
    }

    #[test]
    fn test_encode_decode_interchain_security_module_instruction() {
        let instruction = MessageRecipientInstruction::InterchainSecurityModule;

        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            INTERCHAIN_SECURITY_MODULE_DISCRIMINATOR_SLICE,
        );

        let decoded = MessageRecipientInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }

    #[test]
    fn test_encode_decode_interchain_security_module_account_metas_instruction() {
        let instruction = MessageRecipientInstruction::InterchainSecurityModuleAccountMetas;

        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR_SLICE,
        );

        let decoded = MessageRecipientInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }

    #[test]
    fn test_encode_decode_handle_instruction() {
        let instruction = MessageRecipientInstruction::Handle(HandleInstruction::new(
            69,
            H256::random(),
            vec![1, 2, 3, 4, 5],
        ));

        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            HANDLE_DISCRIMINATOR_SLICE,
        );

        let decoded = MessageRecipientInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }

    #[test]
    fn test_encode_decode_handle_account_metas_instruction() {
        let instruction = MessageRecipientInstruction::HandleAccountMetas(HandleInstruction::new(
            69,
            H256::random(),
            vec![1, 2, 3, 4, 5],
        ));

        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            HANDLE_ACCOUNT_METAS_DISCRIMINATOR_SLICE,
        );

        let decoded = MessageRecipientInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }
}
