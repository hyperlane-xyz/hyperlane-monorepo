use hyperlane_core::{HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage, Mailbox};
use tokio::task::JoinHandle;
use tokio_metrics::TaskMonitor;
use tracing::{info_span, Instrument};

use dymension_kaspa::KaspaProvider;

use crate::db::HyperlaneRocksDB;

use super::new_deposit::{handle_observed_deposits, DepositCache, MetadataConstructor};


use std::time::Duration;
use tokio::time;

struct LoopResources<M: Mailbox, C: MetadataConstructor> {
    domain: HyperlaneDomain,
    kdb: HyperlaneRocksDB,
    task_monitor: TaskMonitor,
    provider: KaspaProvider,
    hub_mailbox: M,
    metadata_constructor: C,
}

pub async fn run_kas_monitor(
    domain: HyperlaneDomain,
    kdb: HyperlaneRocksDB,
    task_monitor: TaskMonitor,
    provider: KaspaProvider,
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
    provider: &KaspaProvider,
) {
    run_monitor(domain, kdb, provider).await;
}

// https://github.com/dymensionxyz/hyperlane-monorepo/blob/20b9e669afcfb7728e66b5932e85c0f7fcbd50c1/dymension/libs/kaspa/lib/relayer/note.md#L102-L119
async fn run_monitor<S: HyperlaneLogStore<HyperlaneMessage>>(
    domain: &HyperlaneDomain,
    store: &S,
    provider: &KaspaProvider,
) where
    S: Clone + 'static,
{
    let mut deposit_cache = DepositCache::new();
    loop {
        let deposits = provider.rest().get_deposits().await.unwrap();
        handle_observed_deposits(provider.validators(), &mut deposit_cache, deposits).await;
        // let logs = deposits_to_logs::<HyperlaneMessage>(deposits).await;
        // let stored= dedupe_and_store_logs(domain, store, logs).await;
        // unimplemented!()
        time::sleep(Duration::from_secs(10)).await;
    }
}
