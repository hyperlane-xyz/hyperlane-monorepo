//! Hyperlane Token program for synthetic tokens.
#![allow(unexpected_cfgs)] // TODO: `rustc` 1.80.1 clippy issue
#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod instruction;
pub mod plugin;
pub mod processor;

pub use spl_associated_token_account;
pub use spl_noop;
pub use spl_token;
pub use spl_token_2022;

// Placeholder program ID for IDL generation
// This will be replaced with the actual deployed program ID
solana_program::declare_id!("HypSynthet1cTokenWarpRoute111111111111111111");
