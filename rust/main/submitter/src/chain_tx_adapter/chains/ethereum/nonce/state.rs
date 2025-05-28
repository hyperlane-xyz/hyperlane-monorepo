use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use hyperlane_core::U256;

use super::super::transaction::Precursor;
use crate::transaction::Transaction;
use crate::TransactionStatus::{Finalized, Included, Mempool, PendingInclusion};
use crate::{SubmitterError, TransactionStatus};

#[derive(Clone)]
pub(crate) enum NonceStatus {
    Free,
    Taken,
    Committed,
}

pub(crate) enum NonceAction {
    Noop,
    Reassign,
}

pub struct NonceManagerStateInner {
    nonces: HashMap<U256, NonceStatus>,
    upper_nonce: U256,
}

pub(crate) struct NonceManagerState {
    inner: Arc<Mutex<NonceManagerStateInner>>,
}

impl NonceManagerStateInner {
    pub fn new() -> Self {
        Self {
            nonces: HashMap::new(),
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
        use crate::transaction::TransactionStatus::{
            Dropped, Finalized, Included, Mempool, PendingInclusion,
        };
        use NonceStatus::{Committed, Free, Taken};

        let precursor = tx.precursor();
        let nonce = precursor.tx.nonce();
        if let Some(nonce) = nonce {
            let nonce_status = match tx_status {
                PendingInclusion | Mempool | Included => Taken,
                Finalized => Committed,
                Dropped(_) => Free,
            };
            self.insert_nonce_status(&nonce.into(), nonce_status).await;
        }
    }

    pub(crate) async fn validate_assigned_nonce(&self, nonce: &U256) -> NonceAction {
        use NonceAction::{Noop, Reassign};
        use NonceStatus::{Committed, Free, Taken};

        let nonce_status = self.get_nonce_status(&nonce.into()).await;

        if let Some(status) = nonce_status {
            match status {
                Free => Reassign,
                Taken | Committed => Noop,
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

    async fn get_nonce_status(&self, nonce: &U256) -> Option<NonceStatus> {
        self.inner.lock().await.nonces.get(nonce).cloned()
    }
}
