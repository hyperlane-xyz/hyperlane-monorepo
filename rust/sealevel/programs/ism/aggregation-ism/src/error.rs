use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    #[error("Account not found in the correct order")]
    AccountOutOfOrder = 1,
    #[error("Account not initialized")]
    AccountNotInitialized = 2,
    #[error("Program ID is not owner")]
    ProgramIdNotOwner = 3,
    #[error("Already initialized")]
    AlreadyInitialized = 4,
    #[error("Threshold not met")]
    ThresholdNotMet = 5,
    #[error("Invalid sub-ISM program")]
    InvalidSubIsm = 6,
    #[error("Metadata length does not match modules length")]
    MetadataModulesMismatch = 7,
    #[error("Invalid threshold: must be > 0 and <= number of modules")]
    InvalidThreshold = 8,
    #[error("Invalid modules: must be non-empty")]
    InvalidModules = 9,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
