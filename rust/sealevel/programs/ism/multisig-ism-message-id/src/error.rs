//! Hyperlane Sealevel mailbox contract specific errors.

use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    #[error("Account not found in the correct order")]
    AccountOutOfOrder = 1,
    #[error("Account is not owner")]
    AccountNotOwner = 2,
    #[error("Program ID is not owner")]
    ProgramIdNotOwner = 3,
    #[error("Account not initialized")]
    AccountNotInitialized = 4,
    #[error("Invalid signature recovery ID")]
    InvalidSignatureRecoveryId = 5,
    #[error("Invalid signature")]
    InvalidSignature = 6,
    #[error("Threshold not met")]
    ThresholdNotMet = 7,
    #[error("Invalid validators and threshold")]
    InvalidValidatorsAndThreshold = 8,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
