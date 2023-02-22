//! Hyperlane bridge contract for Sealevel-compatible (Solana Virtual Machine) chains.

#[deny(warnings)]
// #[deny(missing_docs)] // FIXME
#[deny(unsafe_code)]
pub mod accounts;
pub mod error;
pub mod instruction;
pub mod processor;

pub use hyperlane_core;

// FIXME Read these in at compile time?
solana_program::declare_id!("8TibDpWMQfTjG6JxvF85pxJXxwqXZUCuUx3Q1vwojvRh");
// solana_program::declare_id!("8oQPEeV1Uhmt4VNAdEojJewGnAuEi4pxBinbRvtKmiwJ");

// FIXME set a sane default
pub(crate) static DEFAULT_ISM: &str = "6TCwgXydobJUEqabm7e6SL4FMdiFDvp1pmYoL6xXmRJq";

pub(crate) static DEFAULT_ISM_ACCOUNTS: &[&str] = &[];
