//! Program to pay for gas fees for messages sent to remote chains.

#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod pda_seeds;
pub mod processor;
