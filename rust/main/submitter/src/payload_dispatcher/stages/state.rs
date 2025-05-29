// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::sync::Arc;

use chrono::format;
use derive_new::new;
use eyre::Result;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{error, info, instrument::Instrumented, warn};

use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    metrics,
    settings::{ChainConf, RawChainConf},
};
use hyperlane_core::HyperlaneDomain;

use crate::{
    chain_tx_adapter::{AdaptsChain, ChainAdapterFactory},
    payload::{DropReason, PayloadDetails, PayloadStatus},
    payload_dispatcher::{
        metrics::DispatcherMetrics, DatabaseOrPath, PayloadDb, PayloadDispatcherSettings,
        TransactionDb,
    },
    transaction::Transaction,
    TransactionStatus,
};

/// State that is common to all components of the `PayloadDispatcher`
#[derive(Clone)]
pub struct PayloadDispatcherState {
    pub(crate) payload_db: Arc<dyn PayloadDb>,
    pub(crate) tx_db: Arc<dyn TransactionDb>,
    pub(crate) adapter: Arc<dyn AdaptsChain>,
    pub(crate) metrics: DispatcherMetrics,
    pub(crate) domain: String,
}

impl PayloadDispatcherState {
    pub fn new(
        payload_db: Arc<dyn PayloadDb>,
        tx_db: Arc<dyn TransactionDb>,
        adapter: Arc<dyn AdaptsChain>,
        metrics: DispatcherMetrics,
        domain: String,
    ) -> Self {
        Self {
            payload_db,
            tx_db,
            adapter,
            metrics,
            domain,
        }
    }

    pub async fn try_from_settings(
        settings: PayloadDispatcherSettings,
        metrics: DispatcherMetrics,
    ) -> Result<Self> {
        let db = match settings.db {
            DatabaseOrPath::Database(db) => db,
            DatabaseOrPath::Path(path) => DB::from_path(&path)?,
        };
        let rocksdb = Arc::new(HyperlaneRocksDB::new(&settings.domain, db));
        let adapter = ChainAdapterFactory::build(
            &settings.chain_conf,
            &settings.raw_chain_conf,
            &settings.metrics,
            rocksdb.clone(),
        )
        .await?;
        let payload_db = rocksdb.clone() as Arc<dyn PayloadDb>;
        let tx_db = rocksdb as Arc<dyn TransactionDb>;
        let domain = settings.domain.to_string();
        Ok(Self::new(payload_db, tx_db, adapter, metrics, domain))
    }

    pub(crate) async fn update_status_for_payloads(
        &self,
        details: &[PayloadDetails],
        status: PayloadStatus,
    ) {
        for d in details {
            if let Err(err) = self
                .payload_db
                .store_new_payload_status(&d.id, status.clone())
                .await
            {
                error!(
                    ?err,
                    payload_details = ?details,
                    new_status = ?status,
                    "Error updating payload status in the database"
                );
            }
            self.update_payload_metric_if_dropped(&status);
            info!(?details, new_status=?status, "Updated payload status");
        }
    }

    fn update_payload_metric_if_dropped(&self, status: &PayloadStatus) {
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

    pub(crate) async fn store_tx(&self, tx: &Transaction) {
        if let Err(err) = self.tx_db.store_transaction_by_id(tx).await {
            error!(
                ?err,
                payload_details = ?tx.payload_details,
                "Error storing transaction in the database"
            );
        }
        self.update_status_for_payloads(
            &tx.payload_details,
            PayloadStatus::InTransaction(tx.status.clone()),
        )
        .await;
        for payload_detail in &tx.payload_details {
            if let Err(err) = self
                .payload_db
                .store_tx_id_by_payload_id(&payload_detail.id, &tx.id)
                .await
            {
                error!(
                    ?err,
                    payload_details = ?tx.payload_details,
                    "Error storing to the payload_id to tx_id mapping in the database"
                );
            }
        }
    }
}
