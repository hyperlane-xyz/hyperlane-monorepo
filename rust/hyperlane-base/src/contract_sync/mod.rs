// TODO: Reapply tip buffer
// TODO: Reapply metrics

pub use cursor::*;
use hyperlane_core::db::HyperlaneDB;
use hyperlane_core::HyperlaneDomain;
pub use interchain_gas::*;
pub use mailbox::*;
pub use metrics::ContractSyncMetrics;

use crate::chains::IndexSettings;

mod cursor;
mod interchain_gas;
/// Tools for working with message continuity.
pub mod last_message;
mod mailbox;
mod metrics;
mod schema;

/// Entity that drives the syncing of an agent's db with on-chain data.
/// Extracts chain-specific data (emitted checkpoints, messages, etc) from an
/// `indexer` and fills the agent's db with this data. A CachingMailbox
/// will use a contract sync to spawn syncing tasks to keep the db up-to-date.
#[derive(Debug)]
pub struct ContractSync<I> {
    domain: HyperlaneDomain,
    db: HyperlaneDB,
    indexer: I,
    index_settings: IndexSettings,
    metrics: ContractSyncMetrics,
}

impl<I> ContractSync<I> {
    /// Instantiate new ContractSync
    pub fn new(
        domain: HyperlaneDomain,
        db: HyperlaneDB,
        indexer: I,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Self {
        Self {
            domain,
            db,
            indexer,
            index_settings,
            metrics,
        }
    }
}
