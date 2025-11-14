use crate::api::client::HttpClient;
use eyre::Result;
use hardcode::tx::REQUIRED_FINALITY_BLUE_SCORE_CONFIRMATIONS;
use kaspa_consensus_core::network::NetworkId;
use kaspa_wallet_core::utxo::NetworkParams;
use tracing::error;
/// Returns true if the block is unlikely to be reorged
/// Suitable only for sending transactions to Kaspa: the tranaction will fail if any input
/// is reorged.
/// Unsuitable for doing off-chain work such as minting on a bridge.
pub fn is_mature(daa_score_block: u64, daa_score_virtual: u64, network_id: NetworkId) -> bool {
    //  see https://github.com/kaspanet/rusty-kaspa/blob/v1.0.0/wallet/core/src/storage/transaction/record.rs
    let params = NetworkParams::from(network_id);
    let maturity = params.user_transaction_maturity_period_daa();
    daa_score_virtual >= daa_score_block + maturity
}

/// Result of finality check with detailed status information
#[derive(Debug, Clone)]
pub struct FinalityStatus {
    pub confirmations: i64,
    pub required_confirmations: i64,
}

impl FinalityStatus {
    pub fn is_final(&self) -> bool {
        self.confirmations >= self.required_confirmations
    }
}

/// Returns detailed finality status including confirmation count
/// NOTE: not using 'maturity' because don't want to confuse with the less safe maturity concept used by wallets
pub async fn is_safe_against_reorg(
    rest_client: &HttpClient,
    tx_id: &str,
    block_hash_hint: Option<String>, // enables faster lookup
) -> Result<FinalityStatus> {
    is_safe_against_reorg_n_confs(
        rest_client,
        REQUIRED_FINALITY_BLUE_SCORE_CONFIRMATIONS,
        tx_id,
        block_hash_hint,
    )
    .await
}

/// Checks if a transaction is safe against reorgs with a specified number of confirmations
/// Returns a FinalityStatus with detailed information
pub async fn is_safe_against_reorg_n_confs(
    rest_client: &HttpClient,
    required_confirmations: i64,
    tx_id: &str,
    containing_block_hash_hint: Option<String>, // enables faster lookup
) -> Result<FinalityStatus> {
    // Note: we use the blue score from the rest client rather than querying against our own WPRC node because
    // the rest server anyway delegates this call to its own WRPC node
    // we want a consistent view of the network across both the TX query and the virtual blue score query
    let virtual_blue_score = rest_client.get_blue_score().await?;
    let tx = rest_client
        .get_tx_by_id_slim(tx_id, containing_block_hash_hint)
        .await?;
    if !tx.is_accepted.unwrap_or(false) {
        return Ok(FinalityStatus {
            confirmations: 0,
            required_confirmations,
        });
    }
    let accepting_blue_score = tx
        .accepting_block_blue_score
        .ok_or(eyre::eyre!("Accepting block blue score is missing"))?;

    let mut confirmations = virtual_blue_score - accepting_blue_score;
    if confirmations < 0 {
        confirmations = 0; // This can happen if the accepting block is not yet known to the node
        error!(
            virtual_blue_score = virtual_blue_score,
            accepting_blue_score = accepting_blue_score,
            "kaspa: virtual blue score is less than accepting block blue score"
        );
    }
    Ok(FinalityStatus {
        confirmations,
        required_confirmations,
    })
}
