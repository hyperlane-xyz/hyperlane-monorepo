use solana_program::program_error::ProgramError;

#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum RouterError {
    #[error("Transaction deadline has passed")]
    DeadlinePassed = 1,

    #[error("Unknown command type")]
    UnknownCommand = 2,

    #[error("Invalid command inputs: failed to deserialize")]
    InvalidInputs = 3,

    #[error("Insufficient accounts provided for command")]
    InsufficientAccounts = 4,

    #[error("Insufficient output amount — slippage exceeded")]
    InsufficientOutput = 5,

    #[error("Sweep balance is below minimum")]
    InsufficientBalance = 6,

    #[error("Unsupported bridge type")]
    UnsupportedBridgeType = 7,

    #[error("Bridge fee exceeds maximum")]
    BridgeFeeTooHigh = 8,

    #[error("Invalid recipient address")]
    InvalidRecipient = 9,

    #[error("Commitment mismatch — swap instructions do not match stored commitment")]
    CommitmentMismatch = 10,

    #[error("Commitment has not arrived yet")]
    CommitmentMissing = 11,

    #[error("Commitment already set for this pending swap")]
    CommitmentAlreadySet = 12,

    #[error("No tokens in PDA ATA — token bridge delivery has not arrived yet")]
    InsufficientTokenBalance = 13,

    #[error("Sub-plan recursion depth exceeded")]
    SubPlanDepthExceeded = 14,

    #[error("Arithmetic overflow")]
    Overflow = 15,

    #[error("Caller is not the authorised Hyperlane mailbox process authority")]
    UnauthorizedMailbox = 16,
}

impl From<RouterError> for ProgramError {
    fn from(e: RouterError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
