//! An Aggregation ISM that verifies messages by requiring a threshold-of-N
//! sub-ISMs to pass verification.
//!
//! Unlike the EVM version, because Solana CPIs cannot catch errors, the relayer
//! selects which sub-ISMs to present (via the metadata). All presented sub-ISMs
//! must pass, and the count must meet the threshold.

#![allow(unexpected_cfgs)]
#![deny(warnings)]
#![deny(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod processor;
