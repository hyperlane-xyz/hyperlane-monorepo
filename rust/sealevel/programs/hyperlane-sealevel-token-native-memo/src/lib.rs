//! Hyperlane token program for native tokens with memo support.

#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod instruction;
pub mod processor;

// Re-export plugin and macros from the base native program
pub use hyperlane_sealevel_token_native::hyperlane_token_native_collateral_pda_seeds;
pub use hyperlane_sealevel_token_native::plugin;

pub use spl_noop;
