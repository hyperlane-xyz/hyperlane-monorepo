//! Hyperlane token program for native tokens.

#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod instruction;
pub mod plugin;
pub mod processor;

pub use spl_noop;
