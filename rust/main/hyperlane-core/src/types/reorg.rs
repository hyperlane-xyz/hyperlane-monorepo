use derive_new::new;
use serde::{Deserialize, Serialize};

use crate::H256;

/// Details about a detected chain reorg, from an agent's perspective
#[derive(Debug, Clone, Serialize, Deserialize, new)]
pub struct ReorgEvent {
    /// the merkle root built from this agent's indexed events
    local_merkle_root: H256,
    /// the onchain merkle root
    canonical_merkle_root: H256,
    /// the index of the checkpoint when the reorg was detected
    /// (due to a mismatch between local and canonical merkle roots)
    checkpoint_index: u32,
    /// the timestamp when the reorg was detected, in seconds since the Unix epoch
    unix_timestamp: u64,
    /// (optional) the height of the block when the reorg was detected
    reorg_period: u64,
}
