#[cfg(test)]
mod tests {
    use super::recursive_trace_transactions;
    use dym_kas_core::api::base::RateLimitConfig;
    use dym_kas_core::api::client::HttpClient;
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
            "kaspatest:pz2q7x7munf7p9zduvfed8dj7znkh7z4973mqd995cvrajk7qhkm57jdfl3l9".to_string();

        // Define the anchor UTXO
        let anchor_utxo = TransactionOutpoint {
            transaction_id: Hash::from_bytes(
                hex::decode("3e43fee61f7082a0fbbb9be7509219203e533e3f9cc8dd0aaa21ae4b81c5e9d5")
                    .unwrap()
                    .try_into()
                    .unwrap(),
            ),
            index: 0,
        };

        let new_utxo = TransactionOutpoint {
            transaction_id: Hash::from_bytes(
                hex::decode("49601485182fa057b000d18993db7756fc5a58823c47b64495d5532add38d2ea")
                    .unwrap()
                    .try_into()
                    .unwrap(),
            ),
            index: 0,
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
            0x27, 0xb2, 0x04, 0xce, 0x0d, 0xea, 0xb9, 0xf8, 0xcd, 0x60, 0x2b, 0x11, 0xe9, 0xb9,
            0x29, 0x8d, 0x9d, 0xfc, 0xd2, 0x80, 0x62, 0x72, 0x53, 0x52, 0x60, 0x97, 0x4f, 0x2a,
            0xc3, 0x56, 0x78, 0x2e,
        ]);

        let message_ids = crate::kas_bridge::payload::MessageIDs::new(vec![
            crate::kas_bridge::payload::MessageID(test_id),
        ]);

        // Convert to bytes and back
        let bytes = message_ids.to_bytes();
        let decoded = crate::kas_bridge::payload::MessageIDs::from_bytes(bytes).unwrap();

        assert_eq!(decoded.0.len(), 1);
        assert_eq!(decoded.0[0].0, test_id);
    }
}

// FIXME: test non lineage utxo
// FIXME: test multi hop lineage
// FIXME: test single TX with multiple message IDs
