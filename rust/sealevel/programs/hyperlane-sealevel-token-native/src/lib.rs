//! Hyperlane token program for native tokens.

#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod plugin;
pub mod processor;

pub use spl_noop;

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga");
