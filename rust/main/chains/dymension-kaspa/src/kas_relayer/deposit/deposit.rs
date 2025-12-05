use dym_kas_core::api::client::{Deposit, HttpClient};
use dym_kas_bridge::deposit::DepositFXG;
use dym_kas_core::finality::is_safe_against_reorg;
use eyre::Result;
use hyperlane_core::U256;
pub use kaspa_bip32::secp256k1::PublicKey;
use tracing::{debug, info};

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

pub async fn check_deposit_finality(
    deposit: &Deposit,
    rest_client: &HttpClient,
) -> Result<(), KaspaTxError> {
    let finality_status = is_safe_against_reorg(
        rest_client,
        &deposit.id.to_string(),
        Some(deposit.accepting_block_hash.clone()),
    )
    .await?;

    if !finality_status.is_final() {
        let pending_confirmations =
            finality_status.required_confirmations - finality_status.confirmations;
        let retry_after_secs = if pending_confirmations > 0 {
            pending_confirmations as f64 * 0.1
        } else {
            10.0
        };
        debug!(
            deposit_id = %deposit.id,
            confirmations = finality_status.confirmations,
            required_confirmations = finality_status.required_confirmations,
            retry_after_secs = retry_after_secs,
            "kaspa relayer: deposit not yet safe against reorg"
        );

        return Err(KaspaTxError::NotFinalError {
            confirmations: finality_status.confirmations,
            required_confirmations: finality_status.required_confirmations,
            retry_after_secs,
        });
    }

    info!(
        deposit_id = %deposit.id,
        confirmations = finality_status.confirmations,
        "kaspa relayer: deposit safe against reorg"
    );

    if deposit.block_hashes.is_empty() {
        return Err(eyre::eyre!("Deposit had no block hashes").into());
    }

    Ok(())
}

pub fn build_deposit_fxg(
    hl_message: hyperlane_core::HyperlaneMessage,
    amount: U256,
    utxo_index: usize,
    deposit: &Deposit,
) -> DepositFXG {
    DepositFXG {
        tx_id: deposit.id.to_string(),
        utxo_index,
        amount,
        accepting_block_hash: deposit.accepting_block_hash.clone(),
        containing_block_hash: deposit.block_hashes[0].clone(),
        hl_message,
    }
}

#[cfg(test)]
mod tests {

    use dym_kas_bridge::message::ParsedHL;

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
