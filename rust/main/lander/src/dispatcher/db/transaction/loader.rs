use std::{
    fmt::{Debug, Formatter},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use hyperlane_metric::rpc_operation::{with_rpc_operation, RpcOperation};
use tokio::sync::mpsc::Sender;
use tracing::{debug, info, warn};

use crate::{
    dispatcher::{
        stages::utils::update_tx_status, DbIterator, DispatcherState, LoadableFromDb,
        LoadingOutcome,
    },
    error::LanderError,
    payload::PayloadStatus,
    transaction::{DropReason, Transaction, TransactionStatus},
};

use super::TransactionDb;

/// Kept as `Other` so a rolled-back binary can still decode dropped transactions.
pub(crate) const STALE_RECOVERED_DROP_REASON: &str =
    "stale recovered transaction: payloads already delivered or terminal";

pub struct TransactionDbLoader {
    db: Arc<dyn TransactionDb>,
    state: DispatcherState,
    inclusion_stage_sender: Sender<Transaction>,
    finality_stage_sender: Sender<Transaction>,
    domain: String,
    /// Set once the backward scan passes the first terminal or missing entry. The loader
    /// used to stop there, so non-terminal transactions below it may be long abandoned.
    past_old_boundary: AtomicBool,
}

impl TransactionDbLoader {
    pub fn new(
        state: DispatcherState,
        inclusion_stage_sender: Sender<Transaction>,
        finality_stage_sender: Sender<Transaction>,
        domain: String,
    ) -> Self {
        Self {
            db: state.tx_db.clone(),
            state,
            inclusion_stage_sender,
            finality_stage_sender,
            domain,
            past_old_boundary: AtomicBool::new(false),
        }
    }

    pub async fn into_iterator(self) -> DbIterator<Self> {
        let domain = self.domain.clone();
        DbIterator::new(Arc::new(self), "Transaction".to_string(), true, domain).await
    }

    /// Returns true if the recovered transaction was dropped because it has nothing left to
    /// deliver. Anything uncertain keeps the normal inclusion/finality path.
    async fn drop_if_stale(&self, tx: &mut Transaction) -> Result<bool, LanderError> {
        if tx.payload_details.is_empty() {
            return Ok(false);
        }
        let status = with_rpc_operation(
            RpcOperation::TransactionLifecycle,
            self.state.adapter.tx_status(tx),
        )
        .await;
        match status {
            Ok(TransactionStatus::PendingInclusion | TransactionStatus::Mempool) => {}
            Ok(status) => {
                info!(tx_uuid = ?tx.uuid, ?status, "Recovered transaction is on chain, keeping it");
                return Ok(false);
            }
            Err(err) => {
                warn!(tx_uuid = ?tx.uuid, ?err, "Failed to read recovered transaction status, keeping it");
                return Ok(false);
            }
        }

        for payload in &tx.payload_details {
            let stored = self
                .state
                .payload_db
                .retrieve_payload_by_uuid(&payload.uuid)
                .await?;
            if stored.is_some_and(|p| payload_status_is_terminal(&p.status)) {
                continue;
            }
            match with_rpc_operation(
                RpcOperation::TransactionLifecycle,
                self.state.adapter.payload_delivered(payload),
            )
            .await
            {
                Ok(true) => {}
                Ok(false) => return Ok(false),
                Err(err) => {
                    warn!(tx_uuid = ?tx.uuid, ?payload, ?err, "Failed to check payload delivery, keeping recovered transaction");
                    return Ok(false);
                }
            }
        }

        warn!(
            ?tx,
            "Dropping stale recovered transaction whose payloads are delivered or terminal"
        );
        update_tx_status(
            &self.state,
            tx,
            TransactionStatus::Dropped(DropReason::Other(STALE_RECOVERED_DROP_REASON.to_owned())),
        )
        .await?;
        Ok(true)
    }
}

fn payload_status_is_terminal(status: &PayloadStatus) -> bool {
    matches!(
        status,
        PayloadStatus::Dropped(_)
            | PayloadStatus::InTransaction(TransactionStatus::Finalized)
            | PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
    )
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
        if transaction.is_none() {
            self.past_old_boundary.store(true, Ordering::Relaxed);
        }
        Ok(transaction)
    }

    async fn load(&self, mut item: Self::Item) -> Result<LoadingOutcome, LanderError> {
        if matches!(
            item.status,
            TransactionStatus::PendingInclusion
                | TransactionStatus::Mempool
                | TransactionStatus::Included
        ) && self.past_old_boundary.load(Ordering::Relaxed)
            && self.drop_if_stale(&mut item).await?
        {
            return Ok(LoadingOutcome::Skipped);
        }
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
                self.past_old_boundary.store(true, Ordering::Relaxed);
                Ok(LoadingOutcome::Skipped)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::KnownHyperlaneDomain;
    use tokio::sync::mpsc;

    use crate::{
        dispatcher::DispatcherMetrics,
        tests::test_utils::{dummy_tx, MockAdapter},
        transaction::DropReason,
    };

    use super::*;

    async fn recover_transactions(statuses: &[Option<TransactionStatus>]) -> Duration {
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

        let db = Arc::new(HyperlaneRocksDB::new(
            &domain,
            DB::from_path(directory.path()).unwrap(),
        ));
        let state = DispatcherState::new(
            db.clone(),
            db,
            Arc::new(MockAdapter::new()),
            DispatcherMetrics::dummy_instance(),
            "arbitrum".to_owned(),
        );
        let (inclusion_tx, mut inclusion_rx) = mpsc::channel(statuses.len().max(1));
        let (finality_tx, mut finality_rx) = mpsc::channel(statuses.len().max(1));
        let mut iterator =
            TransactionDbLoader::new(state, inclusion_tx, finality_tx, "arbitrum".to_owned())
                .into_iterator()
                .await;
        let started = Instant::now();
        tokio::time::timeout(
            Duration::from_secs(60),
            iterator.load_from_db(DispatcherMetrics::dummy_instance()),
        )
        .await
        .expect("recovery should finish")
        .unwrap();
        let elapsed = started.elapsed();

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
        elapsed
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

    #[tokio::test]
    #[ignore = "manual terminal-history restart benchmark"]
    async fn benchmark_terminal_history_recovery() {
        for terminal_count in [10_000, 100_000] {
            let mut statuses = vec![Some(TransactionStatus::Finalized); terminal_count + 1];
            statuses[0] = Some(TransactionStatus::PendingInclusion);
            let elapsed = recover_transactions(&statuses).await;
            println!(
                "{terminal_count} terminal transactions plus one oldest pending: recovered 1/1 in {} ms (database population/reopen excluded)",
                elapsed.as_millis(),
            );
        }
    }
}
