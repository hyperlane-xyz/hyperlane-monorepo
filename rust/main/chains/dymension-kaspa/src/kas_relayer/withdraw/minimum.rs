use dym_kas_hardcode::tx::DUST_AMOUNT;
use hyperlane_core::{HyperlaneMessage, U256};
use kaspa_consensus_core::tx::TransactionOutput;
use kaspa_wallet_core::tx::is_transaction_output_dust;

pub fn is_dust(tx_out: &TransactionOutput, min_sompi: U256) -> bool {
    tx_out.value < DUST_AMOUNT
        || is_transaction_output_dust(tx_out)
        || is_small_value(tx_out.value, min_sompi)
}

pub fn is_small_value(value: u64, min_sompi: U256) -> bool {
    value < min_sompi.as_u64()
}

/// Checks if a HyperlaneMessage contains a dust amount (below min_sompi threshold).
pub fn is_dust_message(msg: &HyperlaneMessage, min_sompi: U256) -> bool {
    crate::hl_message::parse_withdrawal_amount(msg)
        .map(|amount| is_small_value(amount, min_sompi))
        .unwrap_or(false)
}
