use multisig_ism::error::MultisigIsmError;
use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    #[error("Account not found in the correct order")]
    AccountOutOfOrder = 1,
    #[error("Program ID is not owner")]
    ProgramIdNotOwner = 2,
    #[error("Account not initialized")]
    AccountNotInitialized = 3,
    #[error("Already initialized")]
    AlreadyInitialized = 4,
    #[error("ISM config tree not set")]
    ConfigNotSet = 5,
    #[error("Invalid metadata")]
    InvalidMetadata = 6,
    #[error("Invalid signature")]
    InvalidSignature = 7,
    #[error("Threshold not met")]
    ThresholdNotMet = 8,
    #[error("No domain config for origin")]
    NoDomainConfig = 9,
    #[error("No route for origin domain")]
    NoRouteForDomain = 10,
    #[error("Invalid relayer")]
    InvalidRelayer = 11,
    #[error("Relayer is not a signer")]
    RelayerNotSigner = 12,
    #[error("Verify rejected (paused or test accept=false)")]
    VerifyRejected = 13,
    #[error("Invalid ISM config (e.g. threshold exceeds sub-ISM count)")]
    InvalidConfig = 14,
    #[error("Message body too short to decode token amount")]
    InvalidMessageBody = 15,
}

impl From<MultisigIsmError> for Error {
    fn from(err: MultisigIsmError) -> Self {
        match err {
            MultisigIsmError::InvalidSignature => Error::InvalidSignature,
            MultisigIsmError::ThresholdNotMet => Error::ThresholdNotMet,
        }
    }
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
