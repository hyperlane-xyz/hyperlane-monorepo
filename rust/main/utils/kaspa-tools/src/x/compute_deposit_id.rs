use dymension_kaspa::ops::message::{add_kaspa_metadata_hl_messsage, ParsedHL};
use eyre::Result;
use kaspa_hashes::Hash;

use std::str::FromStr as _;

/// Compute the Hyperlane message ID for a Kaspa deposit.
///
/// The message ID is deterministically derived from the deposit payload combined
/// with the Kaspa transaction metadata (tx_id, utxo_index). This allows verifying
/// whether a deposit has been processed on the Dymension hub.
pub fn compute_deposit_id(payload: &str, tx_id: &str, utxo_index: usize) -> Result<()> {
    let payload = payload.strip_prefix("0x").unwrap_or(payload);
    let tx_id = tx_id.strip_prefix("0x").unwrap_or(tx_id);

    let parsed = ParsedHL::parse_string(payload)?;

    let tx_hash =
        Hash::from_str(tx_id).map_err(|e| eyre::eyre!("invalid transaction ID: {}", e))?;

    let hl_message_with_metadata = add_kaspa_metadata_hl_messsage(parsed, tx_hash, utxo_index)?;

    let message_id = hl_message_with_metadata.id();

    println!(
        "Hyperlane Message ID: 0x{}",
        hex::encode(message_id.as_bytes())
    );
    println!();
    println!("To check delivery on Dymension hub:");
    println!(
        "  dymd q hyperlane delivered <mailbox_id> 0x{}",
        hex::encode(message_id.as_bytes())
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_deposit_id_basic() {
        // This payload is from the user's real transaction
        let payload = "03000000014088489d00000000000000000000000000000000000000000000000000000000000000005d990b31726f757465725f617070000000000000000000000000000200000000000000000000000000000000000000005b1ae7408e939e381f1d39b8d5dbe9aae7653453000000000000000000000000000000000000000000000000000000174876e800";
        let tx_id = "242b5987b89e939a8777d42072bbd3527dcfceb61048a4cf874fc473f76a1b79";
        let utxo_index = 0;

        let result = compute_deposit_id(payload, tx_id, utxo_index);
        assert!(result.is_ok());
    }

    #[test]
    fn test_compute_deposit_id_with_0x_prefix() {
        let payload = "0x03000000014088489d00000000000000000000000000000000000000000000000000000000000000005d990b31726f757465725f617070000000000000000000000000000200000000000000000000000000000000000000005b1ae7408e939e381f1d39b8d5dbe9aae7653453000000000000000000000000000000000000000000000000000000174876e800";
        let tx_id = "0x242b5987b89e939a8777d42072bbd3527dcfceb61048a4cf874fc473f76a1b79";
        let utxo_index = 0;

        let result = compute_deposit_id(payload, tx_id, utxo_index);
        assert!(result.is_ok());
    }

    #[test]
    fn test_compute_deposit_id_invalid_payload() {
        let result = compute_deposit_id(
            "invalid_hex",
            "242b5987b89e939a8777d42072bbd3527dcfceb61048a4cf874fc473f76a1b79",
            0,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_compute_deposit_id_invalid_tx_id() {
        let payload = "03000000014088489d00000000000000000000000000000000000000000000000000000000000000005d990b31726f757465725f617070000000000000000000000000000200000000000000000000000000000000000000005b1ae7408e939e381f1d39b8d5dbe9aae7653453000000000000000000000000000000000000000000000000000000174876e800";
        let result = compute_deposit_id(payload, "invalid_tx_id", 0);
        assert!(result.is_err());
    }
}
