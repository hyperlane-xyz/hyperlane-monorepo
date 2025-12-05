use dym_kas_hardcode::tx::DUST_AMOUNT;
use hyperlane_core::U256;
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
