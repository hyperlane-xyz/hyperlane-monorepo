//! Cross-collateral error types.

use solana_program::program_error::ProgramError;

/// Custom errors for the cross-collateral token program.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// An extra account was provided that was not required.
    #[error("Unused account(s) provided")]
    ExtraneousAccount = 1,

    /// The router is not authorized for the given domain.
    #[error("Unauthorized router")]
    UnauthorizedRouter = 2,

    /// The CC dispatch authority PDA is invalid.
    #[error("Invalid dispatch authority")]
    InvalidDispatchAuthority = 3,

    /// TokenIxn::Init is not allowed; use CrossCollateralInstruction::Init.
    #[error("Base init not allowed, use cross-collateral init")]
    BaseInitNotAllowed = 4,

    /// TransferRemoteTo called with local domain, or HandleLocal called with remote domain.
    #[error("Invalid domain for instruction")]
    InvalidDomain = 5,

    /// Failed to decode token message.
    #[error("Failed to decode token message")]
    MessageDecodeError = 6,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
