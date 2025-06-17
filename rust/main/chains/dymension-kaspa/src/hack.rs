use hyperlane_base::contract_sync::cursors::Indexable;
use hyperlane_core::{HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage, KnownHyperlaneDomain};
use tracing::{debug, error, info, info_span, warn, Instrument};

use dym_kas_core::query::deposits::get_deposits;

use hyperlane_core::{Indexed, LogMeta, H512};

use std::{
    collections::HashSet, fmt::Debug, hash::Hash, marker::PhantomData, sync::Arc, time::Duration,
    time::UNIX_EPOCH,
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

// https://github.com/dymensionxyz/hyperlane-monorepo/blob/20b9e669afcfb7728e66b5932e85c0f7fcbd50c1/dymension/libs/kaspa/lib/relayer/note.md#L102-L119
pub async fn run_monitor<T: HyperlaneLogStore<HyperlaneMessage>>(store: &T) {
    loop {
        let deposits = get_deposits();
        let logs = deposits_to_logs(deposits).await;
        dedupe_and_store_logs(domain, store, logs).await;
    }
}

async fn deposits_to_logs(deposits: Vec<Deposit>) -> Vec<(Indexed<T>, LogMeta)> {
    unimplemented!()
}

async fn dedupe_and_store_logs<T, S>(
    domain: &HyperlaneDomain,
    store: &S,
    logs: Vec<(Indexed<T>, LogMeta)>,
) -> Vec<(Indexed<T>, LogMeta)>
where
    T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
    S: HyperlaneLogStore<T> + Clone + 'static,
{
    let deduped_logs = HashSet::<_>::from_iter(logs);
    let logs = Vec::from_iter(deduped_logs);

    let stored = match store.store_logs(&logs).await {
        Ok(stored) => stored,
        Err(err) => {
            warn!(?err, "Error storing logs in db");
            Default::default()
        }
    };

    logs
}
