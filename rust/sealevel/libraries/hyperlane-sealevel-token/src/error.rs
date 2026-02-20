//! Errors for the Hyperlane Sealevel Token programs.

use solana_program::program_error::ProgramError;

/// Custom errors that may be returned by the Hyperlane Sealevel Token programs.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// An extra account was provided that was not required.
    #[error("Unused account(s) provided")]
    ExtraneousAccount = 1,

    /// An integer overflow occurred.
    #[error("Integer overflow")]
    IntegerOverflow = 2,

    /// A message decoding error occurred.
    #[error("Message decoding error")]
    MessageDecodeError = 3,

    /// Fee beneficiary account is required when fees are configured.
    #[error("Fee beneficiary account required")]
    FeeBeneficiaryRequired = 4,

    /// CPI to fee program failed.
    #[error("Fee program CPI error")]
    FeeProgramCpiError = 5,

    /// Fee program account does not match config.
    #[error("Fee program mismatch")]
    FeeProgramMismatch = 6,

    /// Fee account does not match config.
    #[error("Fee account mismatch")]
    FeeAccountMismatch = 7,

    /// Fee quote CPI returned invalid or missing data.
    #[error("Fee quote return data invalid")]
    FeeQuoteReturnDataInvalid = 8,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
