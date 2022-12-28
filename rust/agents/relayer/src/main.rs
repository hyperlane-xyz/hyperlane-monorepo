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

mod checkpoint_fetcher;
mod merkle_tree_builder;
mod msg;
mod prover;
mod relayer;
mod settings;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    agent_main::<Relayer>().await
}
