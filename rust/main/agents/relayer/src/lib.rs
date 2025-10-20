#![deny(clippy::unwrap_used, clippy::panic)]
<<<<<<< HEAD
=======
#![deny(clippy::arithmetic_side_effects)]
>>>>>>> main

pub mod msg;

mod db_loader;
mod merkle_tree;
mod metrics;
mod prover;
mod relayer;
mod settings;

#[cfg(test)]
mod test_utils;

pub mod server;

pub use msg::GAS_EXPENDITURE_LOG_MESSAGE;
pub use relayer::*;
