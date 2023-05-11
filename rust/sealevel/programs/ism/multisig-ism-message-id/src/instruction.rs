use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H160;
use solana_program::{program_error::ProgramError};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Input: domain ID, validators, & threshold to set.
    SetValidatorsAndThreshold(Domained<ValidatorsAndThreshold>),
    /// Input: domain ID to query.
    GetValidatorsAndThreshold(u32),
}

impl TryFrom<&[u8]> for Instruction {
    type Error = ProgramError;

    fn try_from(data: &[u8]) -> Result<Self, Self::Error> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct Domained<T> {
    pub domain: u32,
    pub data: T,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct ValidatorsAndThreshold {
    pub validators: Vec<H160>,
    pub threshold: u8,
}
