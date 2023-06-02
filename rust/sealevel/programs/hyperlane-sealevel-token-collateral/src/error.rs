//! TODO

use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    #[error("Unused account(s) provided")]
    ExtraneousAccount = 1,

    #[error("Associated token account balance is too low")]
    AtaBalanceTooLow = 2,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
