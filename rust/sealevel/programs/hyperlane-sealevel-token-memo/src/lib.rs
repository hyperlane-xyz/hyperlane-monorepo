//! Hyperlane Token program for synthetic tokens with memo support.
#![allow(unexpected_cfgs)] // TODO: `rustc` 1.80.1 clippy issue
#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod instruction;
pub mod processor;

// Re-export plugin and macros from the base token program
pub use hyperlane_sealevel_token::plugin;
pub use hyperlane_sealevel_token::{
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_mint_pda_seeds,
};

pub use spl_associated_token_account;
pub use spl_noop;
pub use spl_token;
pub use spl_token_2022;
