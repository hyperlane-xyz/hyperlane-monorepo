//! Hyperlane SVM fee program — on-chain fee computation with offchain quoting.

#![allow(unexpected_cfgs)]
#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod fee_math;
pub mod instruction;
pub mod pda_seeds;
pub mod processor;
