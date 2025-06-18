use crate::contract_sync::cursors::Indexable;
use hyperlane_core::{HyperlaneDomain, HyperlaneLogStore};
use tracing::warn;

use dym_kas_core::deposit::DepositFXG;
use dym_kas_relayer::deposit::on_new_deposit;
use dym_kas_validator::deposit::validate_deposits;
use dymension_kaspa::{Deposit, RestProvider};

use hyperlane_core::{Indexed, LogMeta};

use std::{collections::HashSet, fmt::Debug, hash::Hash};

pub struct DepositCache {
    seen: HashSet<Deposit>,
}

impl DepositCache {
    pub fn new() -> Self {
        Self {
            seen: HashSet::new(),
        }
    }
}

// see https://github.com/dymensionxyz/hyperlane-monorepo/blob/00b8642100af822767ceb605bc2627de7ddde610/rust/main/hyperlane-core/src/types/checkpoint.rs#L32-L51

// need to call to N validators
// on each validator need to call https://github.com/dymensionxyz/hyperlane-monorepo/blob/759e5554b8d27a343220fea27f7c5382082b9b7b/dymension/libs/kaspa/lib/validator/src/deposit.rs#L3
async fn gather_deposit_sigs(deposit: &Deposit) {
    // TODO: needs to return the thing that relayer can send up to hub
    unimplemented!()
}

pub async fn handle_observed_deposits(
    provider: &RestProvider,
    cache: &mut DepositCache,
    deposits: Vec<Deposit>,
) {
    let new_deposits: Vec<Deposit> = deposits
        .into_iter()
        .filter(|deposit| !cache.seen.contains(deposit))
        .collect::<Vec<_>>();
    for deposit in &new_deposits {
        cache.seen.insert(deposit.clone());
    }

    for deposit in &new_deposits {
        let fxg = on_new_deposit(deposit); // local call
        if let Some(fxg) = fxg {
            if validate_deposits(&fxg) {
                // TODO: now to need to get the merkle sig and send up to hub
            }
        }
    }
}

pub async fn deposits_to_logs<T>(deposits: Vec<Deposit>) -> Vec<(Indexed<T>, LogMeta)>
where
    T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
{
    return vec![];
    // unimplemented!()
}

pub async fn dedupe_and_store_logs<T, S>(
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
