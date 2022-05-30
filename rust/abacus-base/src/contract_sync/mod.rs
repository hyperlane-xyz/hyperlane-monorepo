// TODO: Reapply tip buffer
// TODO: Reapply metrics

use std::sync::Arc;

use crate::settings::IndexSettings;
use abacus_core::db::AbacusDB;

mod common;
mod interchain_gas;
mod last_message;
mod metrics;
mod outbox;
mod schema;

pub use common::*;
pub use interchain_gas::*;
pub use metrics::ContractSyncMetrics;
pub use outbox::*;

/// Entity that drives the syncing of an agent's db with on-chain data.
/// Extracts chain-specific data (emitted checkpoints, messages, etc) from an
/// `indexer` and fills the agent's db with this data. A CachingOutbox or
/// CachingInbox will use a contract sync to spawn syncing tasks to keep the
/// db up-to-date.
#[derive(Debug)]
pub struct ContractSync<I> {
    /// The name of the agent.
    pub agent_name: String,
    /// The name of the chain.
    pub chain_name: String,
    /// The DB.
    pub db: AbacusDB,
    /// The Indexer.
    pub indexer: Arc<I>,
    /// Indexing settings.
    pub index_settings: IndexSettings,
    /// Contract sync metrics.
    pub metrics: ContractSyncMetrics,
}

impl<I> ContractSync<I> {
    /// Instantiate new ContractSync
    pub fn new(
        agent_name: String,
        chain_name: String,
        db: AbacusDB,
        indexer: Arc<I>,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Self {
        Self {
            agent_name,
            chain_name,
            db,
            indexer,
            index_settings,
            metrics,
        }
    }
}
