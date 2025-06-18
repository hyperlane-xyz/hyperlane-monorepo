use hyperlane_core::{HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage};
use tokio::task::JoinHandle;
use tokio_metrics::TaskMonitor;
use tracing::{info_span, Instrument};

use dymension_kaspa::RestProvider;

use crate::db::HyperlaneRocksDB;

use super::new_deposit::{handle_observed_deposits, DepositCache};

use std::time::Duration;
use tokio::time;

pub async fn run_kas_monitor(
    domain: HyperlaneDomain,
    kdb: HyperlaneRocksDB,
    task_monitor: TaskMonitor,
    provider: RestProvider,
) -> JoinHandle<()> {
    let name = "foo";
    tokio::task::Builder::new()
        .name(name)
        .spawn(TaskMonitor::instrument(
            &task_monitor,
            async move {
                kas_monitor_task(&domain, &kdb, &provider).await;
            }
            .instrument(info_span!("Kaspa Monitor")),
        ))
        .expect("Failed to spawn kaspa monitor task")
}

async fn kas_monitor_task(
    domain: &HyperlaneDomain,
    kdb: &HyperlaneRocksDB,
    provider: &RestProvider,
) {
    run_monitor(domain, kdb, provider).await;
}

// https://github.com/dymensionxyz/hyperlane-monorepo/blob/20b9e669afcfb7728e66b5932e85c0f7fcbd50c1/dymension/libs/kaspa/lib/relayer/note.md#L102-L119
async fn run_monitor<S: HyperlaneLogStore<HyperlaneMessage>>(
    domain: &HyperlaneDomain,
    store: &S,
    provider: &RestProvider,
) where
    S: Clone + 'static,
{
    let mut deposit_cache = DepositCache::new();
    loop {
        let deposits = provider.get_deposits().await.unwrap();
        handle_observed_deposits(provider, &mut deposit_cache, deposits).await;
        // let logs = deposits_to_logs::<HyperlaneMessage>(deposits).await;
        // let stored= dedupe_and_store_logs(domain, store, logs).await;
        // unimplemented!()
        time::sleep(Duration::from_secs(10)).await;
    }
}
