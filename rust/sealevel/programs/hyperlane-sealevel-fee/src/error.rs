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
    /// Transient quote PDA key does not match derivation from stored scoped_salt.
    #[error("Transient quote PDA mismatch")]
    TransientPdaMismatch = 6,
    /// Transient quote data is invalid (wrong length or format).
    #[error("Invalid transient quote data")]
    InvalidTransientData = 7,
    /// Standing quote amount must be wildcard (u64::MAX).
    #[error("Standing quote amount must be wildcard")]
    StandingQuoteAmountNotWildcard = 8,
    /// Standing quote context is invalid.
    #[error("Invalid standing quote context")]
    InvalidStandingQuoteContext = 9,
    /// Standing quote data is invalid.
    #[error("Invalid standing quote data")]
    InvalidStandingQuoteData = 10,
    /// CC standing quote cannot use H256::zero() as target_router.
    #[error("Zero target router not allowed for CC standing quotes")]
    ZeroTargetRouterNotAllowed = 11,
    /// Domain 0 and u32::MAX (wildcard sentinel) cannot be used as route domains.
    #[error("Invalid route domain")]
    InvalidRouteDomain = 12,
    /// Offchain quoting is not configured (signers is None).
    #[error("Offchain quoting not configured")]
    OffchainQuotingNotConfigured = 13,
    /// SetWildcardQuoteSigners is only valid for Routing/CrossCollateralRouting modes.
    #[error("Wildcard signers not applicable for this fee mode")]
    WildcardSignersNotApplicable = 14,
    /// SetMinIssuedAt must be monotonically increasing (cannot move backward).
    #[error("min_issued_at must be >= current value")]
    MinIssuedAtMustBeMonotonic = 15,
    /// Quoted fee strategy variant does not match the on-chain strategy variant.
    #[error("Quoted curve variant does not match on-chain curve")]
    CurveVariantMismatch = 16,
    /// Fee params max_fee and half_amount must both be nonzero.
    #[error("Fee params must be nonzero")]
    ZeroFeeParams = 17,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
