//! Interchain Security Module that unconditionally approves.
//! **NOT INTENDED FOR USE IN PRODUCTION**

// #![deny(warnings)] // FIXME
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

mod accounts;
mod error;
mod instruction;
mod metadata;
mod processor;

// FIXME Read these in at compile time? And don't use harcoded test keys.
// TODO this needs changing
solana_program::declare_id!("F6dVnLFioQ8hKszqPsmjWPwHn2dJfebgMfztWrzL548V");
