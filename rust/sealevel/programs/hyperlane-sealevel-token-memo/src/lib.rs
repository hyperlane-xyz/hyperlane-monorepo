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
