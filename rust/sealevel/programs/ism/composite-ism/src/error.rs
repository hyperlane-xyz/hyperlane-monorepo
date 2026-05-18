use multisig_ism::error::MultisigIsmError;
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
    #[error("ISM config tree not set")]
    ConfigNotSet = 4,
    #[error("Invalid metadata")]
    InvalidMetadata = 5,
    #[error("Invalid signature")]
    InvalidSignature = 6,
    #[error("Threshold not met")]
    ThresholdNotMet = 7,
    #[error("No route for origin domain")]
    NoRouteForDomain = 8,
    #[error("Invalid relayer")]
    InvalidRelayer = 9,
    #[error("Relayer is not a signer")]
    RelayerNotSigner = 10,
    #[error("Verify rejected (paused or test accept=false)")]
    VerifyRejected = 11,
    #[error("Invalid ISM config (e.g. threshold exceeds sub-ISM count)")]
    InvalidConfig = 12,
    #[error("Message body too short to decode token amount")]
    InvalidMessageBody = 13,
    #[error("Rate limit capacity exceeded")]
    RateLimitExceeded = 14,
    #[error("Message recipient does not match configured recipient")]
    RecipientMismatch = 15,
    #[error("More than one Routing node in the ISM tree")]
    MultipleRoutingNodes = 16,
    #[error("Routing ISM is not allowed inside a domain PDA")]
    RoutingInDomainIsm = 17,
    #[error("Domain PDA must be writable when ISM tree contains a RateLimited node")]
    DomainPdaNotWritable = 18,
    #[error("Expected system program account")]
    InvalidSystemProgram = 19,
    #[error("Storage PDA account does not match expected derived address")]
    InvalidStoragePda = 20,
    #[error("Domain PDA account does not match expected derived address for this origin")]
    InvalidDomainPda = 21,
    #[error("FallbackRouting ISM is not allowed inside a domain PDA")]
    FallbackRoutingInDomainIsm = 22,
    #[error("Fallback ISM account is invalid or missing")]
    InvalidFallbackIsmAccount = 23,
    #[error("CPI to fallback ISM failed or returned no/invalid data")]
    FallbackIsmCallFailed = 24,
    #[error("FallbackRouting must be the last sub-ISM in an Aggregation; placing it earlier drains accounts_iter and starves subsequent siblings")]
    FallbackRoutingNotLast = 25,
    #[error("Process authority account does not match expected PDA for configured mailbox")]
    InvalidProcessAuthority = 26,
    #[error("Process authority must be a signer (Verify must be called via Mailbox.process)")]
    ProcessAuthorityNotSigner = 27,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}

impl From<MultisigIsmError> for Error {
    fn from(err: MultisigIsmError) -> Self {
        match err {
            MultisigIsmError::InvalidSignature => Error::InvalidSignature,
            MultisigIsmError::ThresholdNotMet => Error::ThresholdNotMet,
            MultisigIsmError::InvalidMetadata => Error::InvalidMetadata,
        }
    }
}
