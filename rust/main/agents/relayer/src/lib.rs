#![deny(clippy::unwrap_used, clippy::panic)]
#![deny(clippy::arithmetic_side_effects)]

pub mod msg;

mod db_loader;
mod fast_relay;
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
