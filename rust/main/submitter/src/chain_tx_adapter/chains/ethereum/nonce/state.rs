use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use hyperlane_core::U256;

use crate::transaction::Transaction;
use crate::{SubmitterError, TransactionStatus};

use super::super::transaction::Precursor;

#[derive(Clone)]
pub(crate) enum NonceStatus {
    Free,
    Taken,
    Finalized,
}

pub(crate) enum NonceAction {
    None,
    Reassign,
}

pub struct NonceManagerStateInner {
    tx_in_finality_count: usize,
    nonces: HashMap<U256, NonceStatus>,
    upper_nonce: U256,
}

pub(crate) struct NonceManagerState {
    inner: Arc<Mutex<NonceManagerStateInner>>,
}

impl NonceManagerStateInner {
    pub fn new() -> Self {
        Self {
            tx_in_finality_count: 0,
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

    pub(crate) async fn update_nonce_status(
        &self,
        tx: &Transaction,
        tx_status: &TransactionStatus,
    ) {
        use crate::transaction::TransactionStatus::{
            Dropped, Finalized, Included, Mempool, PendingInclusion,
        };

        let precursor = tx.precursor();
        let nonce = precursor.tx.nonce();
        if let Some(nonce) = nonce {
            let nonce_status = match tx_status {
                PendingInclusion | Mempool | Included => NonceStatus::Taken,
                Finalized => NonceStatus::Finalized,
                Dropped(_) => NonceStatus::Free,
            };
            self.insert_nonce_status(&nonce.into(), nonce_status).await;
        }
    }

    pub(crate) async fn validate_assigned_nonce(
        &self,
        nonce: &U256,
    ) -> Result<NonceAction, SubmitterError> {
        use NonceStatus::{Finalized, Free, Taken};

        let nonce_status = self.get_nonce_status(&nonce.into()).await;

        if let Some(status) = nonce_status {
            match status {
                Free => Ok(NonceAction::Reassign),
                Taken | Finalized => Ok(NonceAction::None),
            }
        } else {
            Ok(NonceAction::Reassign)
        }
    }

    pub(crate) async fn identify_next_nonce(&self) -> Result<U256, SubmitterError> {
        use NonceStatus::Free;

        let guard = self.inner.lock().await;
        let nonces = &guard.nonces;
        let available_nonce = nonces
            .iter()
            .filter(|(_nonce, status)| matches!(status, Free))
            .min_by_key(|(nonce, _)| *nonce)
            .map(|(nonce, _)| nonce)
            .unwrap_or(&guard.upper_nonce);
        Ok(*available_nonce)
    }

    pub(crate) async fn set_tx_in_finality_count(&self, count: usize) {
        let mut guard = self.inner.lock().await;
        guard.tx_in_finality_count = count;
    }

    async fn insert_nonce_status(&self, nonce: &U256, nonce_status: NonceStatus) {
        let mut guard = self.inner.lock().await;

        guard.nonces.insert(nonce.into(), nonce_status);

        if nonce >= &guard.upper_nonce {
            guard.upper_nonce = nonce + 1;
        }
    }

    async fn get_nonce_status(&self, nonce: &U256) -> Option<NonceStatus> {
        self.inner.lock().await.nonces.get(nonce).cloned()
    }
}
