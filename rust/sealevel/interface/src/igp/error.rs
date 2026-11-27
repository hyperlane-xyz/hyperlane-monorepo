//! Hyperlane Sealevel IGP custom errors.

use solana_program::program_error::ProgramError;

/// Custom errors for the IGP program.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// No gas oracle set for destination domain.
    #[error("No gas oracle set for destination domain")]
    NoGasOracleSetForDestinationDomain = 1,
    /// fee_config is not set on the IGP (must call SetIgpQuoteConfig first).
    #[error("Quote config not set")]
    QuoteConfigNotSet = 2,
    /// IGP quote context has wrong length.
    #[error("Invalid IGP quote context")]
    InvalidIgpQuoteContext = 3,
    /// IGP quote data has wrong length.
    #[error("Invalid IGP quote data")]
    InvalidIgpQuoteData = 4,
    /// Phase 3: only SOL (Pubkey::default()) is supported as fee token mint.
    #[error("Non-default fee token mint not supported")]
    NonDefaultFeeTokenMint = 5,
    /// Standing quote has not expired yet (cannot close).
    #[error("Standing quote not expired")]
    StandingQuoteNotExpired = 6,
    /// Beneficiary does not match the IGP's beneficiary.
    #[error("Beneficiary mismatch")]
    BeneficiaryMismatch = 7,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
