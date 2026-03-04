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
    use hyperlane_core::{H160, H256};

    use super::{Filter::*, MatchInfo, MatchingList};

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

    #[test]
    fn test_ica_body_matching_list_regex() {
        // ICA owner-based matching pattern from app-contexts/mainnet_config.json (superswap_ica_v2)
        // Pattern matches: COMMITMENT type + specific owner (Velodrome Universal Router) + any ISM + arbitrary suffix
        // Owner: 0x01D40099fCD87C018969B0e8D4aB1633Fb34763C
        let ica_commitment_owner_pattern =
            r#"^01000000000000000000000001d40099fcd87c018969b0e8d4ab1633fb34763c.{64}"#;
        let commitment_list: MatchingList = serde_json::from_str(&format!(
            r#"[{{"bodyregex": "{}"}}]"#,
            ica_commitment_owner_pattern
        ))
        .unwrap();

        // Test 1: COMMITMENT message with matching owner should match
        // Format: type(01) + owner + ism + salt + commitment
        let commitment_message_body = "01000000000000000000000001d40099fcd87c018969b0e8d4ab1633fb34763c000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000000000000000000000000000000000000000000000000001abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

        assert!(
            commitment_list.matches(
                MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453, // Base
                    src_addr: &H256::default(),
                    dst_domain: 10, // Optimism
                    dst_addr: &H256::default(),
                    body: commitment_message_body.into(),
                },
                false
            ),
            "COMMITMENT message with matching owner should match"
        );

        // Test 2: CALLS message should NOT match (wrong type)
        let calls_message_body = "00000000000000000000000001d40099fcd87c018969b0e8d4ab1633fb34763c000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000000000000000000000000000000000000000000000000001deadbeef";

        assert!(
            !commitment_list.matches(
                MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453,
                    src_addr: &H256::default(),
                    dst_domain: 10,
                    dst_addr: &H256::default(),
                    body: calls_message_body.into(),
                },
                false
            ),
            "CALLS message should NOT match COMMITMENT pattern"
        );

        // Test 3: REVEAL message should NOT match (different layout, no owner field)
        // Real REVEAL message from https://gist.github.com/yorhodes/e4b19fa63c6195cb725efbc3011e3abb
        // Format: type(02) + ism + commitment
        let reveal_message_body = "020000000000000000000000000000000000000000000000000000000000000000002cd4f1bbd58a9c7fc481e3b8d319cea8795011b9dde770fa122c2e585fa01f69";

        assert!(
            !commitment_list.matches(
                MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 10, // Optimism
                    src_addr: &H256::default(),
                    dst_domain: 1135, // Lisk
                    dst_addr: &H256::default(),
                    body: reveal_message_body.into(),
                },
                false
            ),
            "REVEAL message should NOT match COMMITMENT+owner pattern"
        );

        // Test 4: COMMITMENT message with different owner should NOT match
        let different_owner_commitment = "01000000000000000000000002d40099fcd87c018969b0e8d4ab1633fb34763c000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000000000000000000000000000000000000000000000000001abcdef";

        assert!(
            !commitment_list.matches(
                MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453,
                    src_addr: &H256::default(),
                    dst_domain: 10,
                    dst_addr: &H256::default(),
                    body: different_owner_commitment.into(),
                },
                false
            ),
            "COMMITMENT message with different owner should NOT match"
        );

        // Test 5: Pattern should match arbitrary suffixes (no end anchor)
        let commitment_with_extra_data = "01000000000000000000000001d40099fcd87c018969b0e8d4ab1633fb34763c000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000000000000000000000000000000000000000000000000001abcdefcafebabe1234567890extradatahere";

        assert!(
            commitment_list.matches(
                MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453,
                    src_addr: &H256::default(),
                    dst_domain: 42220, // Celo
                    dst_addr: &H256::default(),
                    body: commitment_with_extra_data.into(),
                },
                false
            ),
            "Pattern should match messages with arbitrary suffixes"
        );

        // Test 6: REVEAL type matching (no owner filtering)
        let reveal_pattern = r#"^02.{64}"#;
        let reveal_list: MatchingList =
            serde_json::from_str(&format!(r#"[{{"bodyregex": "{}"}}]"#, reveal_pattern)).unwrap();

        assert!(
            reveal_list.matches(
                MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 10,
                    src_addr: &H256::default(),
                    dst_domain: 1135,
                    dst_addr: &H256::default(),
                    body: reveal_message_body.into(),
                },
                false
            ),
            "REVEAL message should match type-based pattern"
        );

        // Test 7: REVEAL pattern should NOT match CALLS or COMMITMENT
        assert!(
            !reveal_list.matches(
                MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453,
                    src_addr: &H256::default(),
                    dst_domain: 10,
                    dst_addr: &H256::default(),
                    body: calls_message_body.into(),
                },
                false
            ),
            "CALLS message should NOT match REVEAL pattern"
        );

        assert!(
            !reveal_list.matches(
                MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453,
                    src_addr: &H256::default(),
                    dst_domain: 10,
                    dst_addr: &H256::default(),
                    body: commitment_message_body.into(),
                },
                false
            ),
            "COMMITMENT message should NOT match REVEAL pattern"
        );
    }
}
