use crate::contract_sync::cursors::Indexable;
use hyperlane_core::{HyperlaneDomain, HyperlaneLogStore};
use tracing::{info, warn};

use dym_kas_core::deposit::DepositFXG;
use dym_kas_relayer::deposit::on_new_deposit;
use dymension_kaspa::{Deposit, RestProvider, ValidatorsClient};

use hyperlane_core::{traits::TxOutcome, ChainResult, HyperlaneMessage, Indexed, LogMeta};

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

pub async fn handle_observed_deposits(
    validators_client: &ValidatorsClient,
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
        let fxg = on_new_deposit(deposit); // local call to F()
        if let Some(fxg) = fxg {
            let results = validators_client.get_deposit_sigs(&fxg).await;
            match results {
                Ok(results) => {
                    // TODO: combine sigs and send up to hub
                }
                Err(e) => {
                    warn!(?e, "Error validating new kaspa deposits");
                }
            }
        }
    }
}

async fn gather_sigs_and_send_to_hub(
    validators_client: &ValidatorsClient,
    fxg: &DepositFXG,
) -> ChainResult<TxOutcome> {
    // need to ultimately send to https://github.com/dymensionxyz/hyperlane-monorepo/blob/1a603d65e0073037da896534fc52da4332a7a7b1/rust/main/chains/hyperlane-cosmos-native/src/mailbox.rs#L131
    let m: HyperlaneMessage = HyperlaneMessage::default(); // TODO: from depositsfx
    let sigs_res = validators_client.get_deposit_sigs(&fxg).await;
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
