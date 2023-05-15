use std::fmt::Debug;
use std::sync::Arc;

use derive_new::new;
use tokio::task::JoinHandle;
use tracing::{info_span, instrument::Instrumented, Instrument};

use hyperlane_core::{HyperlaneDB, InterchainGasPaymaster, InterchainGasPaymasterIndexer};

use crate::{
    chains::IndexSettings, ContractSync, ContractSyncMetrics, RateLimitedSyncBlockRangeCursor,
    SyncType,
};

/// Caching InterchainGasPaymaster type
#[derive(Debug, Clone, new)]
pub struct CachingInterchainGasPaymaster {
    paymaster: Arc<dyn InterchainGasPaymaster>,
    db: Arc<dyn HyperlaneDB>,
    indexer: Arc<dyn InterchainGasPaymasterIndexer>,
}

impl std::fmt::Display for CachingInterchainGasPaymaster {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingInterchainGasPaymaster {
    /// Return handle on paymaster object
    pub fn paymaster(&self) -> &Arc<dyn InterchainGasPaymaster> {
        &self.paymaster
    }

    /// Return handle on HyperlaneRocksDB
    pub fn db(&self) -> &Arc<dyn HyperlaneDB> {
        &self.db
    }

    /// Spawn a task that syncs the CachingInterchainGasPaymaster's db with the
    /// on-chain event data
    pub async fn sync_gas_payments(
        &self,
        index_settings: IndexSettings,
        sync_type: SyncType,
        metrics: ContractSyncMetrics,
    ) -> eyre::Result<Vec<Instrumented<JoinHandle<eyre::Result<()>>>>> {
        let sync = ContractSync::new(
            self.paymaster.domain().clone(),
            self.db.clone(),
            self.indexer.clone(),
            index_settings.clone(),
            metrics,
        );
        match sync_type {
            SyncType::Forward => {
                let forward_cursor = Box::new(
                    RateLimitedSyncBlockRangeCursor::new(
                        self.indexer.clone(),
                        index_settings.chunk_size,
                        index_settings.from,
                    )
                    .await?,
                );
                Ok(vec![tokio::spawn(async move {
                    sync.sync_gas_payments(forward_cursor).await
                })
                .instrument(
                    info_span!("InterchainGasPaymasterContractSync", self = %self),
                )])
            }
            SyncType::MiddleOut => {
                panic!("not yet implemented");
            }
        }
    }
}
