use std::collections::HashMap;
use std::ops::Deref;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::transaction::{Transaction, TransactionId};

#[derive(Debug, Clone)]
pub struct FinalityStagePool {
    pool: Arc<Mutex<HashMap<TransactionId, Transaction>>>,
}

impl FinalityStagePool {
    pub fn new() -> Self {
        Self {
            pool: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, transaction: Transaction) -> usize {
        let mut pool = self.pool.lock().await;
        pool.insert(transaction.id.clone(), transaction);
        pool.len()
    }

    pub async fn remove(&self, id: &TransactionId) -> usize {
        let mut pool = self.pool.lock().await;
        pool.remove(id);
        pool.len()
    }

    pub async fn snapshot(&self) -> HashMap<TransactionId, Transaction> {
        let pool = self.pool.lock().await;
        pool.clone()
    }
}

#[cfg(test)]
impl Deref for FinalityStagePool {
    type Target = Arc<Mutex<HashMap<TransactionId, Transaction>>>;

    fn deref(&self) -> &Self::Target {
        &self.pool
    }
}
