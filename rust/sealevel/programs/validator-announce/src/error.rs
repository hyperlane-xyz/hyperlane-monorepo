//! Hyperlane Sealevel mailbox contract specific errors.

use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, PartialEq)]
#[repr(u32)]
pub enum Error {
    #[error("Signature error")]
    SignatureError = 1,
    #[error("Signer mismatch")]
    SignerMismatch = 2,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
