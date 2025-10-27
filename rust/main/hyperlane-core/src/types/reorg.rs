use derive_new::new;
use serde::{Deserialize, Serialize};

use crate::{ReorgPeriod, H256};

/// Details about a detected chain reorg, from an agent's perspective
#[derive(Debug, Clone, Serialize, Deserialize, new, PartialEq, Default)]
pub struct ReorgEvent {
    /// the merkle root built from this agent's indexed events
    pub local_merkle_root: H256,
    /// the onchain merkle root
    pub canonical_merkle_root: H256,
    /// the index of the checkpoint when the reorg was detected
    /// (due to a mismatch between local and canonical merkle roots)
    pub checkpoint_index: u32,
    /// the timestamp when the reorg was detected, in seconds since the Unix epoch
    pub unix_timestamp: u64,
    /// the reorg period configured for the agent
    pub reorg_period: ReorgPeriod,
}
