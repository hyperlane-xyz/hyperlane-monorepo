use corelib::deposit::DepositFXG;
use corelib::finality::is_safe_against_reorg;
use corelib::message::ParsedHL;
use corelib::{
    api::client::{Deposit, HttpClient},
    message::add_kaspa_metadata_hl_messsage,
};
use eyre::{eyre, Result};
use hyperlane_core::U256;
pub use secp256k1::PublicKey;
use tracing::{info, warn};

/// Error type for deposit processing that includes retry timing information
#[derive(Debug)]
pub enum KaspaTxError {
    NotFinalError {
        confirmations: i64,
        required_confirmations: i64,
        retry_after_secs: f64,
    },
    ProcessingError(eyre::Error),
}

impl std::fmt::Display for KaspaTxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KaspaTxError::NotFinalError {
                confirmations,
                required_confirmations,
                retry_after_secs,
            } => {
                write!(
                    f,
                    "Deposit not final enough: {}/{} confirmations. Retry in {:.1}s",
                    confirmations, required_confirmations, retry_after_secs
                )
            }
            KaspaTxError::ProcessingError(err) => {
                write!(f, "Processing error: {}", err)
            }
        }
    }
}

impl std::error::Error for KaspaTxError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            KaspaTxError::NotFinalError { .. } => None,
            KaspaTxError::ProcessingError(err) => Some(err.as_ref()),
        }
    }
}

impl From<eyre::Error> for KaspaTxError {
    fn from(err: eyre::Error) -> Self {
        KaspaTxError::ProcessingError(err)
    }
}

pub async fn on_new_deposit(
    escrow_address: &str,
    deposit: &Deposit,
    rest_client: &HttpClient,
) -> Result<Option<DepositFXG>, KaspaTxError> {
    // Check if the deposit is safe against reorg first
    let finality_status = is_safe_against_reorg(
        rest_client,
        &deposit.id.to_string(),
        Some(deposit.accepting_block_hash.clone()),
    )
    .await?;

    if !finality_status.is_final() {
        let pending_confirmations =
            finality_status.required_confirmations - finality_status.confirmations;
        // we assume 10 confirmations per second, so retry after 0.1 seconds per confirmation needed
        let mut retry_after_secs;
        if pending_confirmations > 0 {
            retry_after_secs = pending_confirmations as f64 * 0.1;
        } else {
            retry_after_secs = 10.0; // Fallback to 10 seconds if no confirmations returned, since it can happen if the accepting block is not yet known to the node
        }
        warn!(
            "Deposit {} is not yet safe against reorg. Confirmations: {}/{}. Will retry in {:.1}s",
            deposit.id,
            finality_status.confirmations,
            finality_status.required_confirmations,
            retry_after_secs
        );

        return Err(KaspaTxError::NotFinalError {
            confirmations: finality_status.confirmations,
            required_confirmations: finality_status.required_confirmations,
            retry_after_secs,
        });
    }

    info!(
        "Deposit {} is safe against reorg with {} confirmations",
        deposit.id, finality_status.confirmations
    );

    // decode payload into Hyperlane message
    let payload = deposit.payload.clone().unwrap();
    let parsed_hl = ParsedHL::parse_string(&payload)?;
    info!(
        "Dymension, parsed new deposit HL message: {:?}",
        parsed_hl.hl_message
    );

    let amt_hl = parsed_hl.token_message.amount();
    // find the index of the utxo that satisfies the transfer amount in hl message
    let utxo_index = deposit
        .outputs
        .iter()
        .position(|utxo: &api_rs::models::TxOutput| {
            U256::from(utxo.amount) >= amt_hl
                && utxo.script_public_key_address.as_ref().unwrap() == escrow_address
        })
        .ok_or(eyre::eyre!("kaspa deposit {} had insufficient sompi amount",deposit.id))?;

    let hl_message_new = add_kaspa_metadata_hl_messsage(parsed_hl, deposit.id, utxo_index)?;

    if deposit.block_hashes.is_empty() {
        return Err(eyre::eyre!("kaspa deposit had no block hashes").into());
    }

    // build response for validator
    let tx = DepositFXG {
        tx_id: deposit.id.to_string(),
        utxo_index,
        amount: amt_hl,
        accepting_block_hash: deposit.accepting_block_hash.clone(),
        containing_block_hash: deposit.block_hashes[0].clone(), // used by validator to find tx by block

        hl_message: hl_message_new,
    };
    Ok(Some(tx))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_parsed_hl_parse() {
        let inputs = [
            "030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000029956d5fc7253fde73070a965c50051e03437fda8f657fdd8fb5926c402bf7520000000000000000000000000000000000000000000000000000000005f5e100",
            "030000000004d10892ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff804b267ca0726f757465725f6170700000000000000000000000000002000000000000000000000000000000000000000089760f514dcfcccf1e4c5edc6bf6041931c4c18300000000000000000000000000000000000000000000000000000000000003e8",
        ];
        for input in inputs {
            let parsed = ParsedHL::parse_string(input);
            match parsed {
                Ok(parsed) => {
                    println!("hl_message: {:?}", parsed.hl_message);
                    println!("token_message: {:?}", parsed.token_message);
                }
                Err(e) => {
                    panic!("parse error: {:?}", e);
                }
            }
        }
    }
}
