//! The hyperlane-sealevel-token-collateral program.

#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod error;
pub mod instruction;
pub mod plugin;
pub mod processor;

pub use spl_associated_token_account;
pub use spl_noop;
pub use spl_token;
pub use spl_token_2022;

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("G8t1qe3YnYvhi1zS9ioUXuVFkwhBgvfHaLJt5X6PF18z");
