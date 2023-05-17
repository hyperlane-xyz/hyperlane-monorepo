//! TODO

use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    #[error("TODO")]
    TODO = 1,

    #[error("Unused account(s) provided")]
    ExtraneousAccount = 2,
    // #[error("Hyperlane message is malformatted")]
    // MalformattedHyperlaneMessage = 2,
    // #[error("Unsupported message version")]
    // UnsupportedMessageVersion = 3,
    // #[error("Incorrect destination domain")]
    // IncorrectDestinationDomain = 4,
    // #[error("Message has already been processed")]
    // DuplicateMessage = 5,
    // #[error("Transaction log budget exceeded so cannot emit event")]
    // LogBudgetExceeded = 7,
    // #[error("Message is larger than the maximum allowed")]
    // MaxMessageSizeExceeded = 8,
    // #[error("Invalid account public key")]
    // InvalidPubkey = 9,
    // #[error("Account not found in the correct order")]
    // AccountOutOfOrder = 10,
    // #[error("Account is read only")]
    // AccountReadOnly = 11,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
