//! Re-exports matching list types from hyperlane-core and adds relayer-specific extensions.

pub use hyperlane_core::matching_list::*;

use ethers::utils::hex;
use hyperlane_core::QueueOperation;

/// Extension trait for relayer-specific matching on queue operations
pub trait MatchingListExt {
    /// Check if queue operation matches any of the rules.
    /// If the matching list is empty, we assume the queue operation does not match.
    fn op_matches(&self, op: &QueueOperation) -> bool;
}

impl MatchingListExt for MatchingList {
    fn op_matches(&self, op: &QueueOperation) -> bool {
        let info = MatchInfo {
            src_msg_id: op.id(),
            src_domain: op.origin_domain_id(),
            src_addr: op.sender_address(),
            dst_domain: op.destination_domain().id(),
            dst_addr: op.recipient_address(),
            body: hex::encode(op.body()),
        };
        self.matches(info, false)
    }
}
