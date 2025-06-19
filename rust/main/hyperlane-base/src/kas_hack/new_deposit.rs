use crate::contract_sync::cursors::Indexable;
use hyperlane_core::{HyperlaneDomain, HyperlaneLogStore};
use tracing::{info, warn};

use dym_kas_core::deposit::DepositFXG;
use dym_kas_relayer::deposit::on_new_deposit;
use dym_kas_validator::deposit::validate_deposits;
use dymension_kaspa::{Deposit, RestProvider, ValidatorsClient};

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

// tODO: see https://github.com/dymensionxyz/hyperlane-monorepo/blob/00b8642100af822767ceb605bc2627de7ddde610/rust/main/hyperlane-core/src/types/checkpoint.rs#L32-L51

struct Sigs{
    sigs: Vec<Vec<u8>>,
}


pub async fn handle_observed_deposits(
    validators: &ValidatorsClient,
    cache: &mut DepositCache,
    deposits: Vec<Deposit>,
) {
    let new_deposits: Vec<Deposit> = deposits
        .into_iter()
        .filter(|deposit| !cache.seen.contains(deposit))
        .collect::<Vec<_>>();
    for deposit in &new_deposits {
        cache.seen.insert(deposit.clone());
        info!("FOOX: New deposit: {:?}", deposit);
    }

    for deposit in &new_deposits {
        let fxg = on_new_deposit(deposit); // local call
        if let Some(fxg) = fxg {
            let results = validators.validate_deposits(&fxg).await;
            match results {
                Ok(results) => {
                    // TODO: need to return a sig
                }
                Err(e) => {
                    warn!(?e, "Error validating new kaspa deposits");
                } 
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
