use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use hyperlane_core::U256;

use crate::transaction::{Transaction, TransactionUuid};
use crate::TransactionStatus;

use super::super::transaction::Precursor;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum NonceStatus {
    /// The nonce which we track, but is not currently assigned to any transaction.
    Free,
    /// The nonce is currently assigned to a transaction that is not yet finalised.
    Taken(TransactionUuid),
    /// The nonce is assigned to a transaction that has been finalised.
    Committed(TransactionUuid),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum NonceAction {
    Noop,
    Reassign,
}

pub struct NonceManagerStateInner {
    nonces: HashMap<U256, NonceStatus>,
    lowest_nonce: U256,
    /// The lowest nonce which is not tracked by the manager and can be assigned.
    /// This is not the next nonce necessarily since if `nonces` contains a nonce
    /// with status `Free`, it will be returned as the next available nonce.
    upper_nonce: U256,
}

pub struct NonceManagerState {
    inner: Arc<Mutex<NonceManagerStateInner>>,
}

impl NonceManagerStateInner {
    pub fn new() -> Self {
        Self {
            nonces: HashMap::new(),
            lowest_nonce: U256::zero(),
            upper_nonce: U256::zero(),
        }
    }
}

impl NonceManagerState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(NonceManagerStateInner::new())),
        }
    }

    pub(crate) async fn update_boundary_nonces(&self, nonce: &U256) {
        let mut guard = self.inner.lock().await;

        guard.lowest_nonce = *nonce;
        if guard.lowest_nonce > guard.upper_nonce {
            guard.upper_nonce = *nonce;
        }
    }

    pub(crate) async fn insert_nonce_status(&self, nonce: &U256, nonce_status: NonceStatus) {
        let mut guard = self.inner.lock().await;

        guard.nonces.insert(nonce.into(), nonce_status);

        if nonce >= &guard.upper_nonce {
            guard.upper_nonce = nonce + 1;
        }
    }

    pub(crate) async fn update_nonce_status(
        &self,
        tx: &Transaction,
        tx_status: &TransactionStatus,
    ) {
        use NonceStatus::{Committed, Free, Taken};
        use TransactionStatus::{Dropped, Finalized, Included, Mempool, PendingInclusion};

        let precursor = tx.precursor();
        let nonce = precursor.tx.nonce();
        if let Some(nonce) = nonce {
            let nonce_status = match tx_status {
                PendingInclusion | Mempool | Included => Taken(tx.uuid.clone()),
                Finalized => Committed(tx.uuid.clone()),
                Dropped(_) => Free,
            };
            self.insert_nonce_status(&nonce.into(), nonce_status).await;
        }
    }

    pub(crate) async fn validate_assigned_nonce(
        &self,
        nonce: &U256,
        tx_uuid: &TransactionUuid,
    ) -> NonceAction {
        use NonceAction::{Noop, Reassign};
        use NonceStatus::{Committed, Free, Taken};

        let (nonce_status, lowest_nonce) =
            self.get_nonce_status_and_lowest_nonce(&nonce.into()).await;

        if let Some(status) = nonce_status {
            match status {
                Free => Reassign,
                Taken(_) if nonce < &lowest_nonce => Reassign,
                Taken(uuid) | Committed(uuid) if &uuid != tx_uuid => Reassign,
                Taken(_) | Committed(_) => Noop,
            }
        } else {
            Reassign
        }
    }

    pub(crate) async fn identify_next_nonce(&self) -> U256 {
        use NonceStatus::Free;

        let guard = self.inner.lock().await;
        let nonces = &guard.nonces;
        let available_nonce = nonces
            .iter()
            .filter(|(_nonce, status)| matches!(status, Free))
            .min_by_key(|(nonce, _)| *nonce)
            .map(|(nonce, _)| nonce)
            .unwrap_or(&guard.upper_nonce);
        *available_nonce
    }

    async fn get_nonce_status_and_lowest_nonce(&self, nonce: &U256) -> (Option<NonceStatus>, U256) {
        let guard = self.inner.lock().await;
        (guard.nonces.get(nonce).cloned(), guard.lowest_nonce)
    }
}

#[cfg(test)]
mod tests;
