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
    #[error("Failed to parse token message from message body")]
    InvalidTokenMessage = 5,
    #[error("Sub-ISM program does not match configured ISM for this amount range")]
    WrongSubIsm = 6,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
