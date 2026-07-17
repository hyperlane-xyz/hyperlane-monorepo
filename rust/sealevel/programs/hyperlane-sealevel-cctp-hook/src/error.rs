use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    #[error("Program ID is not owner")]
    ProgramIdNotOwner = 1,
    #[error("Account not initialized")]
    AccountNotInitialized = 2,
    #[error("Already initialized")]
    AlreadyInitialized = 3,
    #[error("Expected system program account")]
    InvalidSystemProgram = 4,
    #[error("Program data account does not match expected derived address")]
    InvalidProgramDataAccount = 5,
    #[error("Remote config account does not match expected derived address for this domain")]
    InvalidRemoteConfigAccount = 6,
    #[error("No remote config set for this destination domain")]
    RemoteConfigNotSet = 7,
    #[error("Sender authority PDA does not match expected derived address")]
    InvalidSenderAuthority = 8,
    #[error(
        "Circle MessageTransmitterV2 program account does not match the configured program ID"
    )]
    InvalidCircleProgram = 9,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
