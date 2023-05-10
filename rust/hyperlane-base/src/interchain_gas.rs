use std::fmt::Debug;
use std::sync::Arc;

use derive_new::new;
use eyre::Result;
use tokio::task::JoinHandle;
use tracing::{info_span, instrument::Instrumented, Instrument};

use hyperlane_core::{InterchainGasPaymaster, InterchainGasPaymasterIndexer};

use crate::{chains::IndexSettings, db::HyperlaneDB, ContractSync, ContractSyncMetrics};

/// Caching InterchainGasPaymaster type
#[derive(Debug, Clone, new)]
pub struct CachingInterchainGasPaymaster {
    paymaster: Arc<dyn InterchainGasPaymaster>,
    db: HyperlaneDB,
    indexer: Arc<dyn InterchainGasPaymasterIndexer>,
}

impl CachingInterchainGasPaymaster {
    /// Return handle on paymaster object
    pub fn paymaster(&self) -> &Arc<dyn InterchainGasPaymaster> {
        &self.paymaster
    }

    /// Return handle on HyperlaneDB
    pub fn db(&self) -> &HyperlaneDB {
        &self.db
    }

    /// Spawn a task that syncs the CachingInterchainGasPaymaster's db with the
    /// on-chain event data
    pub fn sync(
        &self,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let sync = ContractSync::new(
            self.paymaster.domain().clone(),
            self.db.clone(),
            self.indexer.clone(),
            index_settings,
            metrics,
        );

        tokio::spawn(async move { sync.sync_gas_payments().await })
            .instrument(info_span!("InterchainGasPaymasterContractSync", self=%self.paymaster.domain()))
    }
}
