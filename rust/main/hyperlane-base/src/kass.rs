use super::contract_sync::cursors::Indexable;
use hyperlane_core::{HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage, KnownHyperlaneDomain};
use tokio_metrics::TaskMonitor;
use tracing::{info_span, warn, Instrument};
use tokio::{
    sync::{
        broadcast::Sender as BroadcastSender,
        mpsc::{self, Receiver as MpscReceiver, UnboundedSender},
        RwLock,
    },
    task::JoinHandle,
};

use super::db::HyperlaneRocksDB;

use dym_kas_core::query::deposits::*;

use hyperlane_core::{Indexed, LogMeta};

use std::{
    collections::HashSet, fmt::Debug, hash::Hash,
};

/// is it a kaspa domain?
pub fn is_kas(d: &HyperlaneDomain) -> bool {
    match d {
        HyperlaneDomain::Known(domain) => matches!(
            domain,
            KnownHyperlaneDomain::Kaspa
                | KnownHyperlaneDomain::KaspaTest10
                | KnownHyperlaneDomain::KaspaLocal
        ),
        HyperlaneDomain::Unknown { .. } => false,
    }
}

pub async fn run_kas_monitor(domain: HyperlaneDomain, kdb: HyperlaneRocksDB, task_monitor: TaskMonitor) -> JoinHandle<()> {
    let name = "foo";
    tokio::task::Builder::new()
        .name(name)
        .spawn(TaskMonitor::instrument(
            &task_monitor,
            async move {
                kas_monitor_task(&domain, kdb).await;
            }
            .instrument(info_span!("Kaspa Monitor")),
        ))
        .expect("Failed to spawn kaspa monitor task")
}

async fn kas_monitor_task(domain: &HyperlaneDomain, kdb: HyperlaneRocksDB) {
    run_monitor(domain, &kdb).await;
}

// https://github.com/dymensionxyz/hyperlane-monorepo/blob/20b9e669afcfb7728e66b5932e85c0f7fcbd50c1/dymension/libs/kaspa/lib/relayer/note.md#L102-L119
async fn run_monitor<S: HyperlaneLogStore<HyperlaneMessage>>(domain: &HyperlaneDomain, store: &S) where S: Clone + 'static {
    loop {
        let deposits = get_deposits();
        let logs = deposits_to_logs(deposits).await;
        let stored= dedupe_and_store_logs(domain, store, logs).await;
        unimplemented!()
    }
}

async fn deposits_to_logs<T>(deposits: Vec<Deposit>) -> Vec<(Indexed<T>, LogMeta)> where T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static {
    unimplemented!()
}

async fn dedupe_and_store_logs<T, S>(
    _domain: &HyperlaneDomain,
    store: &S,
    logs: Vec<(Indexed<T>, LogMeta)>,
) -> Vec<(Indexed<T>, LogMeta)>
where
    T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
    S: HyperlaneLogStore<T> + Clone + 'static,
{
   // TODO: need to lock store? 
    let deduped_logs = HashSet::<_>::from_iter(logs);
    let logs = Vec::from_iter(deduped_logs);

    let _stored = match store.store_logs(&logs).await {
        Ok(stored) => stored,
        Err(err) => {
            warn!(?err, "Error storing logs in db");
            Default::default()
        }
    };

    logs
}
