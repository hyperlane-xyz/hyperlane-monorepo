//! A multisig Interchain Security Module that accepts signatures over
//! a checkpoint the message ID that matches the message being verified.
//! No merkle proofs.

#![deny(warnings)]
#![deny(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod metadata;
pub mod processor;
