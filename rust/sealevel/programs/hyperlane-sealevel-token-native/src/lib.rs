//! Hyperlane token program for native tokens.

#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod instruction;
pub mod plugin;
pub mod processor;

pub use spl_noop;

// Placeholder program ID for IDL generation
// This will be replaced with the actual deployed program ID
solana_program::declare_id!("HypNat1veTokenWarpRoute111111111111111111111");
