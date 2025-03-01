//! The relayer forwards signed checkpoints from the current chain's mailbox to
//! the other chains' mailboxes
//!
//! At a regular interval, the relayer polls the current chain's mailbox for
//! signed checkpoints and submits them as checkpoints on the remote mailbox.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use eyre::Result;

use hyperlane_base::agent_main;

use relayer::Relayer;

#[cfg(feature = "memory-profiling")]
mod memory_profiler;

/// Number of worker threads matches the number of CPU requested for relayer
/// https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/4ddbd60e1f2e150e58dfeab72171c4fa88203db4/typescript/infra/config/environments/mainnet3/agent.ts#L595
#[tokio::main(flavor = "multi_thread", worker_threads = 14)]
async fn main() -> Result<()> {
    // Logging is not initialised at this point, so, using `println!`
    println!("Relayer starting up...");

    let agent_main_fut = agent_main::<Relayer>();

    #[cfg(feature = "memory-profiling")]
    memory_profiler::run_future(agent_main_fut).await?;

    #[cfg(not(feature = "memory-profiling"))]
    agent_main_fut.await?;

    Ok(())
}
