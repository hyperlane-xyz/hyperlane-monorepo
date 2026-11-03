//! Shared block/transaction enrichment and same-chain CCR persistence.
pub(crate) use storage::txn_id_for_meta;
pub use storage::HyperlaneDbStore;

mod same_chain_ccr_swaps;
mod storage;
