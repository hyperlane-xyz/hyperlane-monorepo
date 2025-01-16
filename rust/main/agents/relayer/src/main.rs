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

#[tokio::main(flavor = "multi_thread", worker_threads = 20)]
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
