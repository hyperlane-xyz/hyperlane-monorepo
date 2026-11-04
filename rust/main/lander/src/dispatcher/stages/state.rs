// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use chrono::format;
use derive_new::new;
use eyre::Result;
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
};
use tracing::{error, info, instrument, instrument::Instrumented, warn};

use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    metrics,
    settings::{ChainConf, RawChainConf},
};
use hyperlane_core::HyperlaneDomain;

use crate::{
    adapter::{AdapterFactory, AdaptsChain},
    dispatcher::{
        metrics::DispatcherMetrics, BuildingStageQueue, DatabaseOrPath, DispatcherSettings,
        PayloadDb, TransactionDb,
    },
    payload::{DropReason, PayloadDetails, PayloadStatus},
    transaction::Transaction,
    TransactionStatus,
};

/// State that is common to all components of the `PayloadDispatcher`
#[derive(Clone)]
pub struct DispatcherState {
    pub(crate) payload_db: Arc<dyn PayloadDb>,
    pub(crate) tx_db: Arc<dyn TransactionDb>,
    pub(crate) adapter: Arc<dyn AdaptsChain>,
    pub(crate) metrics: DispatcherMetrics,
    pub(crate) domain: String,
    pub(crate) building_stage_queue: BuildingStageQueue,
    recovery_gate: Arc<RecoveryGate>,
    reprocess_txs_wakeup: Arc<Notify>,
}

struct RecoveryGate {
    ready: AtomicBool,
    activity: Notify,
}

impl RecoveryGate {
    fn new(ready: bool) -> Self {
        Self {
            ready: AtomicBool::new(ready),
            activity: Notify::new(),
        }
    }

    async fn wait(&self) {
        while !self.ready.load(Ordering::Acquire) {
            let notified = self.activity.notified();
            if self.ready.load(Ordering::Acquire) {
                break;
            }
            notified.await;
        }
    }

    fn open(&self) {
        self.ready.store(true, Ordering::Release);
        self.activity.notify_waiters();
    }
}

impl DispatcherState {
    pub fn new(
        payload_db: Arc<dyn PayloadDb>,
        tx_db: Arc<dyn TransactionDb>,
        adapter: Arc<dyn AdaptsChain>,
        metrics: DispatcherMetrics,
        domain: String,
    ) -> Self {
        Self::new_with_recovery_state(payload_db, tx_db, adapter, metrics, domain, true)
    }

    fn new_with_recovery_state(
        payload_db: Arc<dyn PayloadDb>,
        tx_db: Arc<dyn TransactionDb>,
        adapter: Arc<dyn AdaptsChain>,
        metrics: DispatcherMetrics,
        domain: String,
        recovery_complete: bool,
    ) -> Self {
        Self {
            payload_db,
            tx_db,
            adapter,
            metrics,
            domain,
            building_stage_queue: BuildingStageQueue::new(),
            recovery_gate: Arc::new(RecoveryGate::new(recovery_complete)),
            reprocess_txs_wakeup: Arc::new(Notify::new()),
        }
    }

    pub(crate) fn new_recovery_pending(
        payload_db: Arc<dyn PayloadDb>,
        tx_db: Arc<dyn TransactionDb>,
        adapter: Arc<dyn AdaptsChain>,
        metrics: DispatcherMetrics,
        domain: String,
    ) -> Self {
        Self::new_with_recovery_state(payload_db, tx_db, adapter, metrics, domain, false)
    }

    pub(crate) async fn wait_for_recovery(&self) {
        self.recovery_gate.wait().await;
    }

    pub(crate) fn mark_recovery_complete(&self) {
        self.recovery_gate.open();
    }

    pub(crate) fn notify_reprocess_txs_activity(&self) {
        self.reprocess_txs_wakeup.notify_one();
    }

    pub(crate) async fn wait_for_reprocess_txs_activity(&self) {
        self.reprocess_txs_wakeup.notified().await;
    }

    pub async fn try_from_settings(
        settings: DispatcherSettings,
        metrics: DispatcherMetrics,
    ) -> Result<Self> {
        let db = match settings.db {
            DatabaseOrPath::Database(db) => db,
            DatabaseOrPath::Path(path) => DB::from_path_with_rollback_wal(&path)?,
        };
        let rocksdb = Arc::new(HyperlaneRocksDB::new(&settings.domain, db));
        let adapter = AdapterFactory::build(
            &settings.chain_conf,
            &settings.raw_chain_conf,
            rocksdb.clone(),
            &settings.metrics,
            metrics.clone(),
        )
        .await?;
        let payload_db = rocksdb.clone() as Arc<dyn PayloadDb>;
        let tx_db = rocksdb as Arc<dyn TransactionDb>;
        let domain = settings.domain.to_string();
        Ok(Self::new_recovery_pending(
            payload_db, tx_db, adapter, metrics, domain,
        ))
    }

    pub(crate) async fn update_status_for_payloads(
        &self,
        details: &[PayloadDetails],
        status: PayloadStatus,
    ) -> Result<(), crate::LanderError> {
        self.persist_status_for_payloads(details, &status).await?;
        for _ in details {
            self.update_payload_metric_if_dropped(&status);
        }
        Ok(())
    }

    async fn persist_status_for_payloads(
        &self,
        details: &[PayloadDetails],
        status: &PayloadStatus,
    ) -> Result<(), crate::LanderError> {
        for d in details {
            self.payload_db
                .store_new_payload_status(&d.uuid, status.clone())
                .await?;
            info!(?details, new_status=?status, "Updated payload status");
        }
        Ok(())
    }

    pub(super) fn update_payload_metric_if_dropped(&self, status: &PayloadStatus) {
        match status {
            PayloadStatus::InTransaction(TransactionStatus::Dropped(ref reason)) => {
                self.metrics.update_dropped_payloads_metric(
                    &format!("DroppedInTransaction({reason:?})"),
                    &self.domain,
                );
            }
            PayloadStatus::Dropped(ref reason) => {
                self.metrics
                    .update_dropped_payloads_metric(&format!("{reason:?}"), &self.domain);
            }
            _ => {}
        }
    }

    #[instrument(
        skip_all,
        name = "DispatcherState::store_tx",
        fields(tx_uuid = ?tx.uuid, tx_status = ?tx.status, payloads = ?tx.payload_details)
    )]
    pub(crate) async fn store_tx(&self, tx: &Transaction) -> Result<(), crate::LanderError> {
        let terminal = matches!(
            tx.status,
            TransactionStatus::Finalized | TransactionStatus::Dropped(_)
        );
        // Nonterminal records are recovery markers. Recovery repairs their
        // payload writes before the pending payload queue is loaded.
        if !terminal {
            self.tx_db.store_transaction_by_uuid(tx).await?;
        }
        let payload_status = PayloadStatus::InTransaction(tx.status.clone());
        self.persist_status_for_payloads(&tx.payload_details, &payload_status)
            .await?;
        for payload_detail in &tx.payload_details {
            self.payload_db
                .store_tx_uuid_by_payload_uuid(&payload_detail.uuid, &tx.uuid)
                .await?;
        }
        // A terminal marker must never hide unfinished payload/association work.
        if terminal {
            self.tx_db.store_transaction_by_uuid(tx).await?;
        }
        for _ in &tx.payload_details {
            self.update_payload_metric_if_dropped(&payload_status);
        }
        Ok(())
    }

    /// Retain the exact built/submitted transaction across storage outages.
    /// Rebuilding or rebroadcasting before repairing its recovery record could
    /// lose nonce/hash ownership or create a second transaction for a payload.
    pub(crate) async fn store_tx_until_success(&self, tx: &Transaction) {
        loop {
            match self.store_tx(tx).await {
                Ok(()) => return,
                Err(error) => {
                    error!(?error, tx_uuid = ?tx.uuid, "Transaction persistence failed; retaining transaction");
                    self.metrics.update_call_retries_metric(
                        "DbError",
                        "Persisting transaction",
                        &self.domain,
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    }
}
