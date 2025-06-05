use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use tracing::{error, warn};

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
    AssignNew,
    FreeAndAssignNew,
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

    pub(crate) async fn insert_nonce_status(&self, nonce: U256, nonce_status: NonceStatus) {
        let mut guard = self.inner.lock().await;

        guard.nonces.insert(nonce, nonce_status);

        if nonce >= guard.upper_nonce {
            guard.upper_nonce = nonce + 1;
        }
    }

    pub(crate) async fn update_nonce_status(
        &self,
        nonce: U256,
        nonce_status: NonceStatus,
        tx_uuid: &TransactionUuid,
    ) {
        use NonceStatus::{Committed, Free, Taken};

        let (Some(tracked_nonce_status), _) = self.get_nonce_status_and_lowest_nonce(&nonce).await
        else {
            // If the nonce is not tracked, we insert it with the new status.
            self.insert_nonce_status(nonce, nonce_status).await;
            return;
        };

        match &tracked_nonce_status {
            Taken(tracked_tx_uuid) | Committed(tracked_tx_uuid) if tracked_tx_uuid != tx_uuid => {
                // If the nonce is taken or committed with a different transaction,
                // we report an error and do nothing.
                error!(
                    tracked_nonce = ?nonce,
                    tracked_nonce_status = ?tracked_nonce_status,
                    tx_uuid = ?tx_uuid,
                    "Same nonce was assigned to multiple transactions"
                );
            }
            Free | Taken(_) | Committed(_) => {
                // If the nonce is free or assigned to the same transaction,
                // we update the status to the new one.
                self.insert_nonce_status(nonce, nonce_status).await;
            }
        }
    }

    pub(crate) async fn validate_assigned_nonce(
        &self,
        nonce: &U256,
        tx_uuid: &TransactionUuid,
    ) -> NonceAction {
        use NonceAction::{AssignNew, FreeAndAssignNew, Noop};
        use NonceStatus::{Committed, Free, Taken};

        let (nonce_status, lowest_nonce) =
            self.get_nonce_status_and_lowest_nonce(&nonce.into()).await;

        if let Some(status) = nonce_status {
            match status {
                Free => AssignNew,
                Taken(uuid) | Committed(uuid) if &uuid != tx_uuid => AssignNew,
                Taken(_) if nonce < &lowest_nonce => FreeAndAssignNew,
                Taken(_) | Committed(_) => Noop,
            }
        } else {
            AssignNew
        }
    }

    pub(crate) async fn identify_next_nonce(&self) -> U256 {
        use NonceStatus::{Committed, Free};

        let mut guard = self.inner.lock().await;

        let lowest_nonce = guard.lowest_nonce;
        let upper_nonce = guard.upper_nonce;
        let nonces = &mut guard.nonces;

        nonces.retain(|nonce, status| !(matches!(status, Committed(_)) && nonce < &lowest_nonce));

        if nonces.iter().any(|(nonce, _)| nonce < &lowest_nonce) {
            warn!(?nonces, "Nonces below the lowest nonce are being retained");
        }

        let available_nonce = nonces
            .iter()
            .filter(|(_nonce, status)| matches!(status, Free))
            .min_by_key(|(nonce, _)| *nonce)
            .map(|(nonce, _)| nonce)
            .unwrap_or(&upper_nonce);
        *available_nonce
    }

    async fn get_nonce_status_and_lowest_nonce(&self, nonce: &U256) -> (Option<NonceStatus>, U256) {
        let guard = self.inner.lock().await;
        (guard.nonces.get(nonce).cloned(), guard.lowest_nonce)
    }
}

#[cfg(test)]
mod tests;
