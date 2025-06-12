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
}

#[cfg(test)]
impl Deref for FinalityStagePool {
    type Target = Arc<Mutex<HashMap<TransactionUuid, Transaction>>>;

    fn deref(&self) -> &Self::Target {
        &self.pool
    }
}
