//! The hyperlane-sealevel-token-collateral program with memo support.

#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod instruction;
pub mod processor;

// Re-export plugin and macros from the base collateral program
pub use hyperlane_sealevel_token_collateral::plugin;
pub use hyperlane_sealevel_token_collateral::{
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_escrow_pda_seeds,
};

pub use spl_associated_token_account;
pub use spl_noop;
pub use spl_token;
pub use spl_token_2022;
