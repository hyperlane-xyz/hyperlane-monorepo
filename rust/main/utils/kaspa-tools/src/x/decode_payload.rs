use dymension_kaspa::ops::payload::MessageIDs;

/// Decode a Kaspa withdrawal transaction payload (hex string) to extract Hyperlane message IDs.
/// The payload is protobuf-encoded MessageIDs containing a list of 32-byte message IDs.
pub fn decode_payload(payload: &str) -> Result<(), eyre::Error> {
    // Strip optional 0x prefix
    let payload = payload.strip_prefix("0x").unwrap_or(payload);

    let message_ids = MessageIDs::from_tx_payload(payload)?;

    if message_ids.0.is_empty() {
        println!("No message IDs found in payload");
        return Ok(());
    }

    println!("Decoded {} Hyperlane message ID(s):", message_ids.0.len());
    for (i, id) in message_ids.0.iter().enumerate() {
        println!("  [{}] 0x{}", i, hex::encode(id.0.as_bytes()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dymension_kaspa::ops::payload::MessageID;
    use hyperlane_core::H256;

    #[test]
    fn test_decode_known_payload() {
        // Create a known payload by encoding some message IDs
        let msg_id1 = MessageID(H256::from([1u8; 32]));
        let msg_id2 = MessageID(H256::from([2u8; 32]));
        let message_ids = MessageIDs::new(vec![msg_id1, msg_id2]);

        let encoded = hex::encode(message_ids.to_bytes());

        // Decode should succeed
        let result = decode_payload(&encoded);
        assert!(result.is_ok());
    }

    #[test]
    fn test_decode_with_0x_prefix() {
        let msg_id = MessageID(H256::from([42u8; 32]));
        let message_ids = MessageIDs::new(vec![msg_id]);

        let encoded = format!("0x{}", hex::encode(message_ids.to_bytes()));

        let result = decode_payload(&encoded);
        assert!(result.is_ok());
    }

    #[test]
    fn test_decode_invalid_payload() {
        let result = decode_payload("invalid_hex");
        assert!(result.is_err());
    }

    #[test]
    fn test_decode_empty_payload() {
        // Empty protobuf message
        let message_ids = MessageIDs::new(vec![]);
        let encoded = hex::encode(message_ids.to_bytes());

        let result = decode_payload(&encoded);
        assert!(result.is_ok());
    }
}
