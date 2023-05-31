//! A contract for publicly announcing validator storage locations.

// #![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod pda_seeds;
pub mod processor;

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("DH43ae1LwemXAboWwSh8zc9pG8j72gKUEXNi57w8fEnn");
