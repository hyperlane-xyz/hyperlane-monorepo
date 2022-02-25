//! The updater signs updates and submits them to the home chain.
//!
//! This updater polls the Home for queued updates at a regular interval.
//! It signs them and submits them back to the home chain.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

mod produce;
mod settings;
mod submit;
mod updater;

use color_eyre::Result;

use futures_util::future::select_all;

use abacus_base::{cancel_task, AbacusAgent, ContractSyncMetrics, IndexDataTypes};

use crate::{settings::UpdaterSettings as Settings, updater::Updater};

#[allow(unused_must_use)]
async fn _main() -> Result<()> {
    color_eyre::install()?;
    let settings = Settings::new()?;

    let agent = Updater::from_settings(settings).await?;

    agent
        .as_ref()
        .settings
        .tracing
        .start_tracing(agent.metrics().span_duration())?;

    let _ = agent.metrics().run_http_server();

    // this is deliberately different from other agents because the updater
    // does not run replicas. As a result, most of the contents of run_all are
    // broken out here
    let sync_metrics = ContractSyncMetrics::new(agent.metrics(), None);
    let index_settings = agent.as_ref().indexer.clone();
    let sync_task = agent.home().sync(
        Updater::AGENT_NAME.to_owned(),
        index_settings,
        sync_metrics,
        IndexDataTypes::Updates,
    );
    let run_task = agent.run("");

    let futs = vec![sync_task, run_task];
    let (_, _, remaining) = select_all(futs).await;

    for task in remaining.into_iter() {
        cancel_task!(task);
    }

    Ok(())
}

fn main() -> Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(_main())
}
