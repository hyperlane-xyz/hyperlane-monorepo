use std::fmt::Debug;
use std::sync::Arc;

use eyre::Result;
use futures_util::future::select_all;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;
use tracing::{info_span, Instrument};

use abacus_core::db::AbacusDB;
use abacus_core::{AbacusContract, InterchainGasPaymaster, InterchainGasPaymasterIndexer};

use crate::{ContractSync, ContractSyncMetrics, IndexSettings};

/// Caching InterchainGasPaymaster type
#[derive(Debug, Clone)]
pub struct CachingInterchainGasPaymaster {
    paymaster: Arc<dyn InterchainGasPaymaster>,
    db: AbacusDB,
    indexer: Arc<dyn InterchainGasPaymasterIndexer>,
}

impl std::fmt::Display for CachingInterchainGasPaymaster {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingInterchainGasPaymaster {
    /// Instantiate new CachingInterchainGasPaymaster
    pub fn new(
        paymaster: Arc<dyn InterchainGasPaymaster>,
        db: AbacusDB,
        indexer: Arc<dyn InterchainGasPaymasterIndexer>,
    ) -> Self {
        Self {
            paymaster,
            db,
            indexer,
        }
    }

    /// Return handle on paymaster object
    pub fn paymaster(&self) -> &Arc<dyn InterchainGasPaymaster> {
        &self.paymaster
    }

    /// Return handle on AbacusDB
    pub fn db(&self) -> &AbacusDB {
        &self.db
    }

    /// Spawn a task that syncs the CachingInterchainGasPaymaster's db with the
    /// on-chain event data
    pub fn sync(
        &self,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("InterchainGasPaymasterContractSync", self = %self);

        let sync = ContractSync::new(
            self.paymaster.chain_name().into(),
            self.db.clone(),
            self.indexer.clone(),
            index_settings,
            metrics,
        );

        tokio::spawn(async move {
            let tasks = vec![sync.sync_gas_payments()];

            let (_, _, remaining) = select_all(tasks).await;
            for task in remaining.into_iter() {
                cancel_task!(task);
            }

            Ok(())
        })
        .instrument(span)
    }
}
