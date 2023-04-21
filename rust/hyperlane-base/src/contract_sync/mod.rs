use derive_new::new;

pub use cursor::*;
use hyperlane_core::HyperlaneDomain;
pub use interchain_gas::*;
pub use mailbox::*;
pub use metrics::ContractSyncMetrics;

use crate::{chains::IndexSettings, db::HyperlaneDB};

mod cursor;
mod eta_calculator;
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
#[derive(Debug, new)]
pub(crate) struct ContractSync<I> {
    domain: HyperlaneDomain,
    db: HyperlaneDB,
    indexer: I,
    index_settings: IndexSettings,
    metrics: ContractSyncMetrics,
}
