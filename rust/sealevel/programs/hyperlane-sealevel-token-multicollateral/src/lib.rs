//! The hyperlane-sealevel-token-multicollateral program.
//!
//! Extends the collateral token program with multi-router-per-domain
//! enrollment, enabling cross-collateral transfers and same-chain swaps
//! via CPI between enrolled programs.

#![allow(unexpected_cfgs)]
#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod instruction;
pub mod processor;

pub use spl_associated_token_account;
pub use spl_noop;
pub use spl_token;
pub use spl_token_2022;
