//! Fee program error types.

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
    /// Transient quote context does not match the QuoteFee parameters.
    #[error("Transient quote context mismatch")]
    TransientContextMismatch = 9,
    /// Transient quote payer does not match the QuoteFee payer.
    #[error("Transient quote payer mismatch")]
    TransientPayerMismatch = 10,
    /// Transient quote PDA key does not match derivation from stored scoped_salt.
    #[error("Transient quote PDA mismatch")]
    TransientPdaMismatch = 11,
    /// Transient quote data is invalid (wrong length or format).
    #[error("Invalid transient quote data")]
    InvalidTransientData = 12,
    /// Standing quote amount must be wildcard (u64::MAX).
    #[error("Standing quote amount must be wildcard")]
    StandingQuoteAmountNotWildcard = 13,
    /// Fully-wildcarded standing quote (wildcard dest + wildcard recipient) is not allowed.
    #[error("Fully wildcarded standing quote not allowed")]
    FullyWildcardedStandingQuote = 14,
    /// Standing quote context is invalid.
    #[error("Invalid standing quote context")]
    InvalidStandingQuoteContext = 15,
    /// Standing quote data is invalid.
    #[error("Invalid standing quote data")]
    InvalidStandingQuoteData = 16,
    /// CC standing quote cannot use H256::zero() as target_router.
    #[error("Zero target router not allowed for CC standing quotes")]
    ZeroTargetRouterNotAllowed = 17,
    /// Domain 0 and u32::MAX (wildcard sentinel) cannot be used as route domains.
    #[error("Invalid route domain")]
    InvalidRouteDomain = 18,
    /// Quote issued_at is too far in the future (beyond allowed clock skew).
    #[error("Quote issued_at too far in the future")]
    IssuedAtTooFarInFuture = 19,
    /// Offchain quoting is not configured (signers is None).
    #[error("Offchain quoting not configured")]
    OffchainQuotingNotConfigured = 20,
    /// SetWildcardQuoteSigners is only valid for Routing/CrossCollateralRouting modes.
    #[error("Wildcard signers not applicable for this fee mode")]
    WildcardSignersNotApplicable = 21,
    /// SetMinIssuedAt must be monotonically increasing (cannot move backward).
    #[error("min_issued_at must be >= current value")]
    MinIssuedAtMustBeMonotonic = 22,
    /// Quote signature recovered a valid signer, but it is not in the authorized set.
    #[error("Recovered signer is not authorized")]
    UnauthorizedQuoteSigner = 23,
    /// Quote issued_at is below the fee account's min_issued_at threshold.
    #[error("Quote issued_at below min_issued_at")]
    QuoteBelowMinIssuedAt = 24,
    /// Quoted fee strategy variant does not match the on-chain strategy variant.
    #[error("Quoted curve variant does not match on-chain curve")]
    CurveVariantMismatch = 25,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
