use account_utils::{DiscriminatorData, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program.
    ///
    /// Accounts:
    /// 0. `[signer]` The new owner and payer of the storage PDA.
    /// 1. `[writable]` The storage PDA account.
    /// 2. `[executable]` The system program account.
    Initialize(ConfigData),
    /// Updates threshold, lower_ism, and upper_ism. Owner only.
    ///
    /// Accounts:
    /// 0. `[signer]` The owner.
    /// 1. `[writable]` The storage PDA account.
    SetConfig(ConfigData),
    /// Gets the owner. Returns as return data.
    ///
    /// Accounts:
    /// 0. `[]` The storage PDA account.
    GetOwner,
    /// Transfers ownership.
    ///
    /// Accounts:
    /// 0. `[signer]` The current owner.
    /// 1. `[writable]` The storage PDA account.
    TransferOwnership(Option<Pubkey>),
}

impl DiscriminatorData for Instruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] = PROGRAM_INSTRUCTION_DISCRIMINATOR;
}

impl TryFrom<&[u8]> for Instruction {
    type Error = ProgramError;

    fn try_from(data: &[u8]) -> Result<Self, Self::Error> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
pub struct ConfigData {
    pub threshold: u64,
    pub lower_ism: Pubkey,
    pub upper_ism: Pubkey,
}
