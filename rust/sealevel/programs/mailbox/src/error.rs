//! Hyperlane Sealevel Mailbox custom errors.

use solana_program::program_error::ProgramError;

/// Custom errors type for the Mailbox program.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// Some kind of encoding error occurred.
    #[error("Encoding error")]
    EncodeError = 1,
    /// Some kind of decoding error occurred.
    #[error("Decoding error")]
    DecodeError = 2,
    /// The message version is not supported.
    #[error("Unsupported message version")]
    UnsupportedMessageVersion = 3,
    /// The destination domain of the message is not the local domain.
    #[error("Message's destination domain is not the local domain")]
    DestinationDomainNotLocalDomain = 4,
    /// The message has already been processed.
    #[error("Message has already been processed")]
    MessageAlreadyProcessed = 5,
    /// Unused account(s) were provided.
    #[error("Unused account(s) provided")]
    ExtraneousAccount = 6,
    /// The message is too large.
    #[error("Message is larger than the maximum allowed")]
    MaxMessageSizeExceeded = 7,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
