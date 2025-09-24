#[cfg(test)]
mod tests {
    use crate::confirm::recursive_trace_transactions;
    use corelib::api::base::RateLimitConfig;
    use corelib::api::client::HttpClient;
    use hex;
    use kaspa_consensus_core::tx::TransactionOutpoint;
    use kaspa_hashes::Hash;

    #[tokio::test]
    #[ignore = "dont hit real api"]
    // tested over https://explorer-tn10.kaspa.org/txs/1ffa672605af17906d99ba9506dd49406a2e8a3faa2969ab0c8929373aca51d1
    async fn test_trace_transactions() {
        let mut lineage_utxos = Vec::new();
        let mut processed_withdrawals = Vec::new();

        let client = HttpClient::new(
            "https://api-tn10.kaspa.org/".to_string(),
            RateLimitConfig::default(),
        );

        let escrow_address =
            "kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr".to_string();

        // Define the anchor UTXO
        let anchor_utxo = TransactionOutpoint {
            transaction_id: Hash::from_bytes(
                hex::decode("5e1cf6784e7af1808674a252eb417d8fa003135190dd4147caf98d8463a7e73a")
                    .unwrap()
                    .try_into()
                    .unwrap(),
            ),
            index: 0,
        };

        let new_utxo = TransactionOutpoint {
            transaction_id: Hash::from_bytes(
                hex::decode("1ffa672605af17906d99ba9506dd49406a2e8a3faa2969ab0c8929373aca51d1")
                    .unwrap()
                    .try_into()
                    .unwrap(),
            ),
            index: 1,
        };

        // Assert the result
        let result = recursive_trace_transactions(
            &client,
            &escrow_address,
            new_utxo,
            anchor_utxo,
            &mut lineage_utxos,
            &mut processed_withdrawals,
        )
        .await;
        assert!(result.is_ok());
        assert_eq!(lineage_utxos.len(), 2);
        assert_eq!(processed_withdrawals.len(), 1);
    }

    #[test]
    fn message_ids_from_payload() {
        use hyperlane_core::H256;

        // Create a MessageID with a test H256
        let test_id = H256::from_slice(&[
            0x27, 0xb2, 0x04, 0xce, 0x0d, 0xea, 0xb9, 0xf8,
            0xcd, 0x60, 0x2b, 0x11, 0xe9, 0xb9, 0x29, 0x8d,
            0x9d, 0xfc, 0xd2, 0x80, 0x62, 0x72, 0x53, 0x52,
            0x60, 0x97, 0x4f, 0x2a, 0xc3, 0x56, 0x78, 0x2e
        ]);

        let message_ids = corelib::payload::MessageIDs::new(vec![
            corelib::payload::MessageID(test_id)
        ]);

        // Convert to bytes and back
        let bytes = message_ids.to_bytes();
        let decoded = corelib::payload::MessageIDs::from_bytes(bytes).unwrap();

        assert_eq!(decoded.0.len(), 1);
        assert_eq!(decoded.0[0].0, test_id);
    }
}

// FIXME: test non lineage utxo
// FIXME: test multi hop lineage
// FIXME: test single TX with multiple message IDs
