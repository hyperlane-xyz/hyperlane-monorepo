//! A Trusted Relayer ISM that verifies messages by checking the transaction signer
//! matches a configured trusted relayer address.

#![allow(unexpected_cfgs)]
#![deny(warnings)]
#![deny(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod processor;
