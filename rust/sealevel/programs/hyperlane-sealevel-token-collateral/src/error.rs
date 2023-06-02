//! Error types.

use solana_program::program_error::ProgramError;

/// Errors specific to this program.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// An extra account was provided that wasn't used.
    #[error("Unused account(s) provided")]
    ExtraneousAccount = 1,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
