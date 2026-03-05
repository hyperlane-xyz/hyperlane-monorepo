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

#[cfg(test)]
mod test {
    use super::MatchingList;

    #[test]
    fn supports_sequence_h256s() {
        let json_str = r#"[{"origindomain":1399811151,"senderaddress":["0x6AD4DEBA8A147d000C09de6465267a9047d1c217","0x6AD4DEBA8A147d000C09de6465267a9047d1c218"],"destinationdomain":11155111,"recipientaddress":["0x6AD4DEBA8A147d000C09de6465267a9047d1c217","0x6AD4DEBA8A147d000C09de6465267a9047d1c218"]}]"#;

        // Test parsing directly into MatchingList
        serde_json::from_str::<MatchingList>(json_str).unwrap();

        // Test parsing into a Value and then into MatchingList, which is the path used
        // by the agent config parser.
        let val: serde_json::Value = serde_json::from_str(json_str).unwrap();
        let value_parser =
            hyperlane_base::settings::parser::ValueParser::new(Default::default(), &val);
        crate::settings::parse_matching_list(value_parser).unwrap();
    }
}
