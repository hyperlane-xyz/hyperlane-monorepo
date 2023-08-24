//! Custom errors for the program.

use solana_program::program_error::ProgramError;

/// Custom errors for the program.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// An error occurred while verifying a signature.
    #[error("Signature error")]
    SignatureError = 1,
    /// The recovered signer does not match the expected signer.
    #[error("Signer mismatch")]
    SignerMismatch = 2,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
