use account_utils::{DiscriminatorData, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::error::Error;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program.
    ///
    /// Accounts:
    /// 0. `[signer]` The new owner and payer of the storage PDA.
    /// 1. `[writable]` The storage PDA account.
    /// 2. `[executable]` The system program account.
    Initialize(InitConfig),
    /// Sets the modules and threshold. Owner only.
    ///
    /// Accounts:
    /// 0. `[signer]` The owner.
    /// 1. `[writable]` The storage PDA account.
    SetConfig(SetConfigData),
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
pub struct InitConfig {
    pub threshold: u8,
    pub modules: Vec<Pubkey>,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
pub struct SetConfigData {
    pub threshold: u8,
    pub modules: Vec<Pubkey>,
}

impl SetConfigData {
    pub fn validate(&self) -> Result<(), Error> {
        if self.modules.is_empty() {
            return Err(Error::InvalidModules);
        }
        if self.threshold == 0 || self.threshold as usize > self.modules.len() {
            return Err(Error::InvalidThreshold);
        }
        Ok(())
    }
}
