//! A test program that sends and receives messages.

#![deny(warnings)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

pub mod program;
#[cfg(feature = "test-client")]
pub mod test_client;

solana_program::declare_id!("FZ8hyduJy4GQAfBu9zEiuQtk429Gjc6inwHgEW5MvsEm");
