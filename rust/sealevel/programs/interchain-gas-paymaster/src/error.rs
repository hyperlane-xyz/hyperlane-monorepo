//! Hyperlane Sealevel Mailbox custom errors.

use solana_program::program_error::ProgramError;

/// Custom errors type for the Mailbox program.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// No gas oracle set for destination domain.
    #[error("No gas oracle set for destination domain")]
    NoGasOracleSetForDestinationDomain = 1,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
