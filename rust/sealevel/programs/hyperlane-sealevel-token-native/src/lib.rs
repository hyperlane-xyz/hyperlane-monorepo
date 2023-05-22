//! TODO

// #![deny(warnings)] // FIXME
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

pub mod error;
pub mod instruction;
pub mod plugin;
pub mod processor;

pub use spl_noop;

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga");
