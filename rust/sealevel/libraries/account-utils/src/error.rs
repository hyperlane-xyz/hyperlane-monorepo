//! Common account validation errors shared across programs.

use solana_program::program_error::ProgramError;

/// Common account validation errors.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, PartialEq)]
#[repr(u32)]
pub enum AccountError {
    /// fnv1a("AccountError::ExtraneousAccount")
    #[error("Extraneous account")]
    ExtraneousAccount = 1407181317,
}

impl From<AccountError> for ProgramError {
    fn from(e: AccountError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
