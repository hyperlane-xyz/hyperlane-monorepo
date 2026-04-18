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
    #[error("Rate limit capacity exceeded")]
    RateLimitExceeded = 16,
    #[error("Message recipient does not match configured recipient")]
    RecipientMismatch = 17,
    #[error("More than one Routing node in the ISM tree")]
    MultipleRoutingNodes = 18,
    #[error("RateLimited ISM is not allowed inside a domain PDA")]
    RateLimitedInDomainIsm = 19,
    #[error("Routing ISM is not allowed inside a domain PDA")]
    RoutingInDomainIsm = 20,
    #[error("Domain PDA must be writable when ISM tree contains a RateLimited node")]
    DomainPdaNotWritable = 21,
    #[error("Expected system program account")]
    InvalidSystemProgram = 22,
    #[error("Storage PDA account does not match expected derived address")]
    InvalidStoragePda = 23,
    #[error("Domain PDA account does not match expected derived address for this origin")]
    InvalidDomainPda = 24,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
