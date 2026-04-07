//! Cross-collateral error types.
//!
//! For shared errors (`ExtraneousAccount`, `MessageDecodeError`), use
//! `hyperlane_sealevel_token_lib::error::Error` directly.

use solana_program::program_error::ProgramError;

/// Custom errors specific to the cross-collateral token program.
/// Discriminants start at 1000 to avoid collisions with the shared token lib errors.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, num_derive::FromPrimitive, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// The router is not authorized for the given domain.
    #[error("Unauthorized router")]
    UnauthorizedRouter = 1000,

    /// The CC dispatch authority PDA is invalid.
    #[error("Invalid dispatch authority")]
    InvalidDispatchAuthority = 1001,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
