#[cfg(test)]
mod tests {
    use crate::confirm::recursive_trace_transactions;
    use corelib::api::base::RateLimitConfig;
    use corelib::api::client::HttpClient;
    use hex;
    use kaspa_consensus_core::tx::TransactionOutpoint;
    use kaspa_hashes::Hash;

    #[tokio::test]
    #[ignore = "avoid using api"]
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
        // 32-byte (64 hex chars) message ID
        let payload = "27b204ce0deab9f8cd602b11e9b9298d9dfcd28062725352609744f2ac356782";
        let decoded_payload = hex::decode(payload).unwrap();

        // Create a MessageIDs with this single ID
        use hyperlane_core::H256;
        let h256_id = H256::from_slice(&decoded_payload);
        let message_ids =
            corelib::payload::MessageIDs::new(vec![corelib::payload::MessageID(h256_id)]);

        assert_eq!(message_ids.0.len(), 1);
        assert_eq!(message_ids.0[0].0, h256_id);
    }
}

// FIXME: test non lineage utxo
// FIXME: test multi hop lineage
// FIXME: test single TX with multiple message IDs
