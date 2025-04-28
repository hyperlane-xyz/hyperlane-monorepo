use std::{
    fmt::{Debug, Formatter},
    sync::Arc,
};

use async_trait::async_trait;
use derive_new::new;
use tokio::sync::mpsc::Sender;
use tracing::trace;

use crate::{
    error::SubmitterError,
    payload_dispatcher::{DbIterator, LoadableFromDb, LoadingOutcome},
    transaction::{Transaction, TransactionStatus},
};

use super::TransactionDb;

#[derive(new)]
pub struct TransactionDbLoader {
    db: Arc<dyn TransactionDb>,
    inclusion_stage_sender: Sender<Transaction>,
    finality_stage_sender: Sender<Transaction>,
    domain: String,
}
impl TransactionDbLoader {
    pub async fn into_iterator(self) -> DbIterator<Self> {
        let domain = self.domain.clone();
        DbIterator::new(Arc::new(self), "Transaction".to_string(), true, domain).await
    }
}

impl Debug for TransactionDbLoader {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransactionDbLoader").finish()
    }
}

#[async_trait]
impl LoadableFromDb for TransactionDbLoader {
    type Item = Transaction;

    async fn highest_index(&self) -> Result<u32, SubmitterError> {
        Ok(self.db.retrieve_highest_index().await?)
    }

    async fn retrieve_by_index(&self, index: u32) -> Result<Option<Self::Item>, SubmitterError> {
        Ok(self.db.retrieve_transaction_by_index(index).await?)
    }

    async fn load(&self, item: Self::Item) -> Result<LoadingOutcome, SubmitterError> {
        match item.status {
            TransactionStatus::PendingInclusion | TransactionStatus::Mempool => {
                self.inclusion_stage_sender.send(item).await?;
                Ok(LoadingOutcome::Loaded)
            }
            TransactionStatus::Included => {
                self.finality_stage_sender.send(item).await?;
                Ok(LoadingOutcome::Loaded)
            }
            TransactionStatus::Finalized | TransactionStatus::Dropped(_) => {
                trace!(?item, "Transaction already processed");
                Ok(LoadingOutcome::Skipped)
            }
        }
    }
}
