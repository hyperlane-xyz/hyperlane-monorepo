//! Interchain Security Module that unconditionally approves.
//! **NOT INTENDED FOR USE IN PRODUCTION**

#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod program;
#[cfg(feature = "test-client")]
pub mod test_client;

solana_program::declare_id!("CWVYdRomCv3bksSsRTuds9SRR5y17Ft5nPqhaXjp4tnb");
