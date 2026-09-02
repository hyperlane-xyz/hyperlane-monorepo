use std::{collections::HashMap, ops::Deref, sync::Arc};

use tokio::sync::Mutex;

use crate::transaction::{Transaction, TransactionUuid};

#[derive(Debug, Clone)]
pub struct FinalityStagePool {
    pool: Arc<Mutex<HashMap<TransactionUuid, Transaction>>>,
}

impl FinalityStagePool {
    pub fn new() -> Self {
        Self {
            pool: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, transaction: Transaction) -> usize {
        let mut pool = self.pool.lock().await;
        pool.insert(transaction.uuid.clone(), transaction);
        pool.len()
    }

    pub async fn remove(&self, tx_uuid: &TransactionUuid) -> usize {
        let mut pool = self.pool.lock().await;
        pool.remove(tx_uuid);
        pool.len()
    }

    pub async fn snapshot(&self) -> HashMap<TransactionUuid, Transaction> {
        let pool = self.pool.lock().await;
        pool.clone()
    }

    pub async fn replace_if_unchanged(
        &self,
        snapshot: &Transaction,
        replacement: Transaction,
    ) -> bool {
        let mut pool = self.pool.lock().await;
        if pool.get(&snapshot.uuid) != Some(snapshot) {
            return false;
        }
        pool.insert(replacement.uuid.clone(), replacement);
        true
    }
}

#[cfg(test)]
impl Deref for FinalityStagePool {
    type Target = Arc<Mutex<HashMap<TransactionUuid, Transaction>>>;

    fn deref(&self) -> &Self::Target {
        &self.pool
    }
}

#[cfg(test)]
mod tests {
    use crate::{tests::test_utils::dummy_tx, transaction::TransactionStatus};

    use super::FinalityStagePool;

    #[tokio::test]
    async fn stale_snapshot_cannot_replace_newer_pool_entry() {
        let pool = FinalityStagePool::new();
        let snapshot = dummy_tx(vec![], TransactionStatus::Included);
        pool.insert(snapshot.clone()).await;

        let mut newer = snapshot.clone();
        newer.status = TransactionStatus::Finalized;
        pool.insert(newer.clone()).await;

        let mut checked = snapshot.clone();
        checked.last_status_check = Some(chrono::Utc::now());
        assert!(!pool.replace_if_unchanged(&snapshot, checked).await);
        assert_eq!(pool.snapshot().await.get(&snapshot.uuid), Some(&newer));
    }
}
