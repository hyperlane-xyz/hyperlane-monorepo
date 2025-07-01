#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

//! A Hyperlane Token program that uses Circle's CCTP for cross-chain USDC transfers.

pub mod cctp_interface;
pub mod instruction;
pub mod plugin;
pub mod processor;

pub use processor::*;
