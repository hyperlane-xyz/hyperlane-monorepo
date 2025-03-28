// TODO: re-enable clippy warnings
#![allow(dead_code)]

use derive_new::new;
use eyre::Result;
use std::{path::PathBuf, sync::Arc};

use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    settings::{ChainConf, RawChainConf},
};
use hyperlane_core::HyperlaneDomain;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use crate::{
    chain_tx_adapter::{AdaptsChain, ChainTxAdapterBuilder},
    payload::{DropReason, PayloadDb, PayloadDetails},
    transaction::TransactionDb,
};

/// State that is common (but not shared) to all components of the `PayloadDispatcher`
pub struct PayloadDispatcherState {
    pub(crate) payload_db: Arc<dyn PayloadDb>,
    pub(crate) tx_db: Arc<dyn TransactionDb>,
    pub(crate) adapter: Box<dyn AdaptsChain>,
}

impl PayloadDispatcherState {
    pub fn new(
        payload_db: Arc<dyn PayloadDb>,
        tx_db: Arc<dyn TransactionDb>,
        adapter: Box<dyn AdaptsChain>,
    ) -> Self {
        Self {
            payload_db,
            tx_db,
            adapter,
        }
    }

    pub fn try_from_settings(settings: PayloadDispatcherSettings) -> Result<Self> {
        let adapter = ChainTxAdapterBuilder::build(&settings.chain_conf, &settings.raw_chain_conf);
        let db = DB::from_path(&settings.db_path)?;
        let rocksdb = Arc::new(HyperlaneRocksDB::new(&settings.domain, db));
        let payload_db = rocksdb.clone() as Arc<dyn PayloadDb>;
        let tx_db = rocksdb as Arc<dyn TransactionDb>;
        Ok(Self::new(payload_db, tx_db, adapter))
    }

    async fn drop_payloads(&self, details: &[PayloadDetails], reason: DropReason) {
        for d in details {
            if let Err(err) = self
                .payload_db
                .store_new_payload_status(d.id(), PayloadStatus::Dropped(reason.clone()))
                .await
            {
                error!(
                    ?err,
                    payload_details = ?details,
                    "Error updating payload status to `dropped`"
                );
            }
            warn!(?details, "Payload dropped from Building Stage");
        }
    }

    async fn store_tx(&self, tx: &Transaction) {
        if let Err(err) = self.tx_db.store_transaction_by_id(tx).await {
            error!(
                ?err,
                payload_details = ?tx.payload_details(),
                "Error storing transaction in the database"
            );
        }
        for payload_detail in tx.payload_details() {
            if let Err(err) = self
                .payload_db
                .store_new_payload_status(payload_detail.id(), PayloadStatus::PendingInclusion)
                .await
            {
                error!(
                    ?err,
                    payload_details = ?tx.payload_details(),
                    "Error updating payload status to `sent`"
                );
            }

            if let Err(err) = self
                .payload_db
                .store_tx_id_by_payload_id(payload_detail.id(), tx.id())
                .await
            {
                error!(
                    ?err,
                    payload_details = ?tx.payload_details(),
                    "Error storing transaction id in the database"
                );
            }
        }
    }

    async fn simulate_tx(&self, tx: &Transaction) -> Result<()> {
        match self.adapter.simulate_tx(tx).await {
            Ok(true) => {
                info!(?tx, "Transaction simulation succeeded");
                Ok(())
            }
            Ok(false) => Err(eyre::eyre!("Transaction simulation failed")),
            Err(err) => Err(eyre::eyre!("Error simulating transaction: {:?}", err)),
        }
    }
}
