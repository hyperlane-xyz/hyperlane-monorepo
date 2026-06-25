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

    #[error("Invalid recipient address")]
    InvalidRecipient = 8,

    #[error("Commitment has not arrived yet")]
    CommitmentMissing = 9,

    #[error("Commitment already set for this pending swap")]
    CommitmentAlreadySet = 10,

    #[error("No tokens in PDA ATA — token bridge delivery has not arrived yet")]
    InsufficientTokenBalance = 11,

    #[error("Sub-plan recursion depth exceeded")]
    SubPlanDepthExceeded = 12,

    #[error("Arithmetic overflow")]
    Overflow = 13,

    #[error("Caller is not the authorised Hyperlane mailbox process authority")]
    UnauthorizedMailbox = 14,

    #[error("Swap has not expired yet — ClosePendingSwap requires 1 hour after commit")]
    SwapNotExpired = 15,
}

impl From<RouterError> for ProgramError {
    fn from(e: RouterError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
