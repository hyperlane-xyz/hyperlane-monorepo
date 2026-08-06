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

    /// The fee program returned invalid or missing return data.
    #[error("Invalid fee return data")]
    InvalidFeeReturnData = 4,

    /// The fee account is not owned by the configured fee program.
    #[error("Fee account owner mismatch")]
    FeeAccountOwnerMismatch = 5,

    /// The fee beneficiary terminal account was not found within the
    /// maximum number of variable fee section accounts.
    #[error("Fee beneficiary not found")]
    FeeBeneficiaryNotFound = 6,

    /// IGP has offchain quoting configured but caller used legacy (oracle-only) flow.
    #[error("IGP requires new quoting flow")]
    IgpNewFlowRequired = 7,

    /// Fee account domain does not match the token mailbox local domain.
    #[error("Fee account domain mismatch")]
    InvalidFeeAccountDomain = 8,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
