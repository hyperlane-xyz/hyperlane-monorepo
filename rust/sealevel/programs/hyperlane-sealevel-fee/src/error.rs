use solana_program::program_error::ProgramError;

/// Custom errors for the Fee program.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// Fee computation resulted in an overflow.
    #[error("Fee computation overflow")]
    FeeComputationOverflow = 1,
    /// Instruction requires the fee account to be FeeData::Leaf.
    #[error("Fee account is not a Leaf type")]
    NotLeafFeeData = 2,
    /// Instruction requires the fee account to be FeeData::Routing.
    #[error("Fee account is not a Routing type")]
    NotRoutingFeeData = 3,
    /// Instruction requires the fee account to be FeeData::CrossCollateralRouting.
    #[error("Fee account is not a CrossCollateralRouting type")]
    NotCrossCollateralRoutingFeeData = 4,
    /// The route PDA was not found / not initialized.
    #[error("Route not found")]
    RouteNotFound = 5,
    /// Extra accounts were provided beyond what the instruction expects.
    #[error("Extraneous account")]
    ExtraneousAccount = 6,
    /// Quote signature verification failed (invalid or unauthorized signer).
    #[error("Invalid quote signature")]
    InvalidQuoteSignature = 7,
    /// Quote expiry is before issued_at.
    #[error("Invalid quote: expiry before issued_at")]
    InvalidQuoteExpiry = 8,
    /// Quote has expired (Clock::unix_timestamp > expiry).
    #[error("Quote expired")]
    QuoteExpired = 9,
    /// Transient quote context does not match the QuoteFee parameters.
    #[error("Transient quote context mismatch")]
    TransientContextMismatch = 10,
    /// Transient quote payer does not match the QuoteFee payer.
    #[error("Transient quote payer mismatch")]
    TransientPayerMismatch = 11,
    /// Transient quote PDA key does not match derivation from stored scoped_salt.
    #[error("Transient quote PDA mismatch")]
    TransientPdaMismatch = 12,
    /// Transient quote data is invalid (wrong length or format).
    #[error("Invalid transient quote data")]
    InvalidTransientData = 13,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
