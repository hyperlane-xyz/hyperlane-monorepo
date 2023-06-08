//! Interchain Security Module that unconditionally approves.
//! **NOT INTENDED FOR USE IN PRODUCTION**

#![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

pub mod program;
#[cfg(feature = "test-client")]
pub mod test_client;

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("CWVYdRomCv3bksSsRTuds9SRR5y17Ft5nPqhaXjp4tnb");
