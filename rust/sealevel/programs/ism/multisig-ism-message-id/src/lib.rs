//! A multisig Interchain Security Module that accepts signatures over
//! a checkpoint the message ID that matches the message being verified.
//! No merkle proofs.

#![deny(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod metadata;
pub mod processor;

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("2YjtZDiUoptoSsA5eVrDCcX6wxNK6YoEVW7y82x5Z2fw");
