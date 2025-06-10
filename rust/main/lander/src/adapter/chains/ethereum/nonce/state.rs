use std::collections::HashMap;
use std::sync::Arc;

use futures_util::FutureExt;
use tokio::sync::{Mutex, MutexGuard};
use tracing::{error, warn};

use hyperlane_core::U256;

use crate::transaction::{Transaction, TransactionUuid};
use crate::TransactionStatus;

use super::super::transaction::Precursor;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum NonceStatus {
    /// The nonce which we track, but is not currently assigned to any transaction.
    Freed(TransactionUuid),
    /// The nonce is currently assigned to a transaction that is either pending or in mempool.
    Taken(TransactionUuid),
    /// The nonce is currently assigned to a transaction that included.
    Placed(TransactionUuid),
    /// The nonce is assigned to a transaction that has been finalised.
    Committed(TransactionUuid),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum NonceAction {
    Noop,
    Assign,
}

pub struct NonceManagerStateInner {
    nonces: HashMap<U256, NonceStatus>,
    /// The lowest available nonce recorded at the tip of the chain.
    /// If no transactions are in flight, this is the next nonce to be assigned.
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

    pub(crate) async fn update_nonce_status(&self, nonce: U256, nonce_status: NonceStatus) {
        use NonceStatus::{Committed, Freed, Placed, Taken};

        let (Some(tracked_nonce_status), _) = self.get_nonce_status_and_lowest_nonce(&nonce).await
        else {
            // If the nonce is not tracked, we insert it with the new status.
            self.insert_nonce_status(nonce, nonce_status).await;
            return;
        };

        if tracked_nonce_status == nonce_status {
            // If the nonce status is the same as the tracked one, we do nothing.
            return;
        }

        let tracked_tx_uuid = match &tracked_nonce_status {
            Taken(uuid) | Committed(uuid) | Placed(uuid) => uuid,
            Freed(_) => {
                // If the tracked nonce status is Freed, and it differs from the nonce status,
                // we track nonce as assigned to the given transaction.
                self.insert_nonce_status(nonce, nonce_status).await;
                return;
            }
        };

        let tx_uuid = match &nonce_status {
            Freed(uuid) | Taken(uuid) | Placed(uuid) | Committed(uuid) => uuid,
        };

        if tracked_tx_uuid == tx_uuid {
            // If the nonce is assigned to the same transaction, we update the status.
            self.insert_nonce_status(nonce, nonce_status).await;
            return;
        }

        // If the nonce is assigned to a different transaction, we log an error.
        // This should never happen if the signer account is used only within the Lander.
        error!(
            ?nonce,
            ?nonce_status,
            ?tracked_nonce_status,
            "Same nonce was assigned to multiple transactions"
        );
    }

    pub(crate) async fn validate_assigned_nonce(
        &self,
        nonce: &U256,
        nonce_status: &NonceStatus,
    ) -> NonceAction {
        use NonceAction::{Assign, Noop};
        use NonceStatus::{Committed, Freed, Placed, Taken};

        // Getting transaction UUID from the nonce status.
        let tx_uuid = match nonce_status {
            Freed(uuid) | Taken(uuid) | Placed(uuid) | Committed(uuid) => uuid,
        };

        // Fetching the tracked nonce status and the lowest nonce.
        let (tracked_nonce_status, lowest_nonce) =
            self.get_nonce_status_and_lowest_nonce(&nonce.into()).await;

        let Some(tracked_nonce_status) = tracked_nonce_status else {
            // If the nonce currently assigned to the transaction is not tracked,
            // we should assign the new nonce.
            return Assign;
        };

        // Getting the transaction UUID from the tracked nonce status.
        let tracked_tx_uuid = match &tracked_nonce_status {
            Freed(uuid) | Taken(uuid) | Placed(uuid) | Committed(uuid) => uuid,
        };

        if tracked_tx_uuid != tx_uuid {
            // If the tracked nonce is assigned to a different transaction,
            // we should assign the new nonce.
            return Assign;
        }

        match nonce_status {
            Freed(_) => {
                // If the nonce which is currently assigned to the transaction, is Freed,
                // then the transaction was dropped, and we need to submit the transaction again.
                // We should assign the new nonce.
                Assign
            }
            Taken(_) | Placed(_) if nonce < &lowest_nonce => {
                // If the nonce is taken or placed, but it is below the lowest nonce,
                // it means that the current nonce is outdated.
                // We should assign the new nonce.
                Assign
            }
            Taken(_) | Placed(_) | Committed(_) => {
                // If the nonce is taken, placed, or committed, we don't need to do anything.
                Noop
            }
        }
    }

    pub(crate) async fn identify_next_nonce(&self) -> U256 {
        use NonceStatus::{Committed, Freed};

        self.clean().await;

        let mut guard = self.inner.lock().await;

        let lowest_nonce = guard.lowest_nonce;
        let upper_nonce = guard.upper_nonce;
        let nonces = &mut guard.nonces;

        if nonces.iter().any(|(nonce, _)| nonce < &lowest_nonce) {
            // This should never happen after the clearing of obsolete nonces.
            warn!(?nonces, "Nonces below the lowest nonce are being retained");
        }

        let next_available_nonce = nonces
            .iter()
            .filter(|(_nonce, status)| matches!(status, Freed(_)))
            .min_by_key(|(nonce, _)| *nonce)
            .map(|(nonce, _)| nonce)
            .unwrap_or(&upper_nonce);
        *next_available_nonce
    }

    async fn get_nonce_status_and_lowest_nonce(&self, nonce: &U256) -> (Option<NonceStatus>, U256) {
        let guard = self.inner.lock().await;
        (guard.nonces.get(nonce).cloned(), guard.lowest_nonce)
    }

    async fn clean(&self) {
        use NonceStatus::{Committed, Freed};

        let mut guard = self.inner.lock().await;

        let lowest_nonce = guard.lowest_nonce;
        let nonces = &mut guard.nonces;

        nonces.retain(|nonce, _| nonce >= &lowest_nonce);

        guard.upper_nonce = nonces
            .iter()
            .max_by_key(|(nonce, _)| *nonce)
            .map_or(lowest_nonce, |(nonce, _)| nonce + 1)
    }
}

#[cfg(test)]
mod tests;
