use std::{
    fmt::{Debug, Formatter},
    sync::Arc,
};

use async_trait::async_trait;
use derive_new::new;
use tokio::sync::mpsc::Sender;
use tracing::{debug, trace};

use crate::{
    dispatcher::{DbIterator, LoadableFromDb, LoadingOutcome},
    error::LanderError,
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

    async fn highest_index(&self) -> Result<u32, LanderError> {
        let index = self.db.retrieve_highest_transaction_index().await?;
        debug!(?index, "Highest transaction index");
        Ok(index)
    }

    async fn retrieve_by_index(&self, index: u32) -> Result<Option<Self::Item>, LanderError> {
        let transaction = self.db.retrieve_transaction_by_index(index).await?;
        debug!(?transaction, ?index, "Retrieved transaction by index");
        Ok(transaction)
    }

    async fn load(&self, item: Self::Item) -> Result<LoadingOutcome, LanderError> {
        match item.status {
            TransactionStatus::PendingInclusion | TransactionStatus::Mempool => {
                debug!(?item, "Send transaction to inclusion stage");
                self.inclusion_stage_sender
                    .send(item)
                    .await
                    .map_err(Box::new)?;
                Ok(LoadingOutcome::Loaded)
            }
            TransactionStatus::Included => {
                debug!(?item, "Send transaction to finality stage");
                self.finality_stage_sender
                    .send(item)
                    .await
                    .map_err(Box::new)?;
                Ok(LoadingOutcome::Loaded)
            }
            TransactionStatus::Finalized | TransactionStatus::Dropped(_) => {
                debug!(?item, "Transaction already processed");
                Ok(LoadingOutcome::Skipped)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::KnownHyperlaneDomain;
    use tokio::sync::mpsc;

    use crate::{
        dispatcher::DispatcherMetrics, tests::test_utils::dummy_tx, transaction::DropReason,
    };

    use super::*;

    async fn recover_transactions(statuses: &[Option<TransactionStatus>]) {
        let directory = tempfile::tempdir().unwrap();
        let domain = KnownHyperlaneDomain::Arbitrum.into();
        let db = HyperlaneRocksDB::new(&domain, DB::from_path(directory.path()).unwrap());
        let mut expected_inclusion = Vec::new();
        let mut expected_finality = Vec::new();
        for (offset, status) in statuses.iter().enumerate() {
            let index = offset as u32 + 1;
            if let Some(status) = status {
                let tx = dummy_tx(vec![], status.clone());
                db.store_transaction_by_uuid(&tx).await.unwrap();
                match status {
                    TransactionStatus::PendingInclusion | TransactionStatus::Mempool => {
                        expected_inclusion.push(tx.uuid);
                    }
                    TransactionStatus::Included => expected_finality.push(tx.uuid),
                    _ => {}
                }
            }
            // A crash between persisting the high index and the transaction can leave a hole.
            db.store_highest_transaction_index(index).await.unwrap();
        }
        drop(db);

        let db = HyperlaneRocksDB::new(&domain, DB::from_path(directory.path()).unwrap());
        let (inclusion_tx, mut inclusion_rx) = mpsc::channel(statuses.len().max(1));
        let (finality_tx, mut finality_rx) = mpsc::channel(statuses.len().max(1));
        let mut iterator = TransactionDbLoader::new(
            Arc::new(db),
            inclusion_tx,
            finality_tx,
            "arbitrum".to_owned(),
        )
        .into_iterator()
        .await;
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            iterator.load_from_db(DispatcherMetrics::dummy_instance()),
        )
        .await
        .expect("recovery should finish")
        .unwrap();

        expected_inclusion.reverse();
        expected_finality.reverse();
        let mut actual_inclusion = Vec::new();
        let mut actual_finality = Vec::new();
        while let Ok(tx) = inclusion_rx.try_recv() {
            actual_inclusion.push(tx.uuid);
        }
        while let Ok(tx) = finality_rx.try_recv() {
            actual_finality.push(tx.uuid);
        }
        assert_eq!(actual_inclusion, expected_inclusion);
        assert_eq!(actual_finality, expected_finality);
    }

    #[tokio::test]
    async fn restart_recovers_older_transactions_past_terminal_entries() {
        use TransactionStatus::*;
        recover_transactions(&[
            Some(PendingInclusion),
            Some(Finalized),
            Some(Included),
            Some(Dropped(DropReason::Other("test".to_owned()))),
            Some(Mempool),
            Some(Finalized),
        ])
        .await;
    }

    #[tokio::test]
    async fn restart_recovers_older_transactions_past_missing_entries() {
        use TransactionStatus::*;
        recover_transactions(&[Some(Included), None, Some(PendingInclusion), None]).await;
    }

    #[tokio::test]
    async fn restart_finishes_with_no_active_transactions() {
        recover_transactions(&[]).await;
        recover_transactions(&[Some(TransactionStatus::Finalized)]).await;
    }
}
