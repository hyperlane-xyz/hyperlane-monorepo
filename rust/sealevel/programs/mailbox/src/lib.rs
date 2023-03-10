//! Hyperlane bridge contract for Sealevel-compatible (Solana Virtual Machine) chains.

#[deny(warnings)]
// #[deny(missing_docs)] // FIXME
#[deny(unsafe_code)]
pub mod accounts;
pub mod error;
pub mod instruction;
pub mod processor;

pub use hyperlane_core;

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("692KZJaoe2KRcD6uhCQDLLXnLNA5ZLnfvdqjE4aX9iu1");

// FIXME set a sane default
pub(crate) static DEFAULT_ISM: &str = "F6dVnLFioQ8hKszqPsmjWPwHn2dJfebgMfztWrzL548V";

pub(crate) static DEFAULT_ISM_ACCOUNTS: &[&str] = &[];

// FIXME import from spl crate? Also, use correct prog ID not local test ID.
pub static SPL_NOOP: &str = "GpiNbGLpyroc8dFKPhK55eQhhvWn3XUaXJFp5fk5aXUs";
