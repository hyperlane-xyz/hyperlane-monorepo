//! The relayer forwards signed checkpoints from the current chain's mailbox to
//! the other chains' mailboxes
//!
//! At a regular interval, the relayer polls the current chain's mailbox for
//! signed checkpoints and submits them as checkpoints on the remote mailbox.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use eyre::Result;

use hyperlane_base::agent_main;

use crate::relayer::Relayer;

mod merkle_tree;
mod msg;
mod processor;
mod prover;
mod relayer;
mod server;
mod settings;

#[tokio::main(flavor = "multi_thread", worker_threads = 20)]
async fn main() -> Result<()> {
    agent_main::<Relayer>().await
}
