//! Interface shared by the Hyperlane token programs (`hyperlane-sealevel-token-lib`).

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod pda_seeds;

pub use crate::{hyperlane_token_ata_payer_pda_seeds, hyperlane_token_pda_seeds};
