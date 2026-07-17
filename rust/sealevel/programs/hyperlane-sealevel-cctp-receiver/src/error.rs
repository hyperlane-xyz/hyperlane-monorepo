use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    #[error("Unrecognized instruction discriminator")]
    UnknownInstruction = 1,
    #[error("Authority PDA does not match the address derived under Circle's MessageTransmitterV2 program ID")]
    InvalidAuthorityPda = 2,
    #[error("Authority PDA must be a signer (this instruction must be invoked via CPI from Circle's MessageTransmitterV2)")]
    AuthorityNotSigner = 3,
    #[error("Message body must be exactly 32 bytes (a Hyperlane message ID) — token/burn messages are out of scope")]
    InvalidMessageBodyLength = 4,
    #[error("Verified-message PDA does not match the expected derived address")]
    InvalidVerifiedMessageAccount = 5,
    #[error("Verified-message PDA is already initialized")]
    AlreadyInitialized = 6,
    #[error("Expected system program account")]
    InvalidSystemProgram = 7,
    #[error("Payer must be a signer")]
    PayerNotSigner = 8,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
