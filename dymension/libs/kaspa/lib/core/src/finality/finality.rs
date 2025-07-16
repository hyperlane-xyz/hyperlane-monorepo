use crate::api::client::HttpClient;
use eyre::Result;
use hardcode::tx::REQUIRED_FINALITY_BLUE_SCORE_CONFIRMATIONS;
use kaspa_consensus_core::network::NetworkId;
use kaspa_rpc_core::RpcHash;
use kaspa_wallet_core::prelude::DynRpcApi;
use kaspa_wallet_core::utxo::NetworkParams;
use std::sync::Arc;

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

/// returns true if accepted and final (reorg with very low probability)
/// NOTE: not using 'maturity' because don't want to confuse with the less safe maturity concept used by wallets
pub async fn is_safe_against_reorg(
    rest_client: &HttpClient,
    tx_id: &str,
    block_hash_hint: Option<String>, // enables faster lookup
) -> Result<bool> {
    is_safe_against_reorg_n_confs(
        rest_client,
        REQUIRED_FINALITY_BLUE_SCORE_CONFIRMATIONS,
        tx_id,
        block_hash_hint,
    )
    .await
}

pub async fn is_safe_against_reorg_n_confs(
    rest_client: &HttpClient,
    required_confirmations: i64,
    tx_id: &str,
    containing_block_hash_hint: Option<String>, // enables faster lookup
) -> Result<bool> {
    // Note: we use the blue score from the rest client rather than querying against our own WPRC node because
    // the rest server anyway delegates this call to its own WRPC node
    // we want a consistent view of the network across both the TX query and the virtual blue score query
    let virtual_blue_score = rest_client.get_blue_score().await?;
    let tx = rest_client
        .get_tx_by_id_slim(tx_id, containing_block_hash_hint)
        .await?;
    let accepting_blue_score = tx
        .accepting_block_blue_score
        .ok_or(eyre::eyre!("Accepting block blue score is missing"))?;
    Ok(accepting_blue_score + required_confirmations <= virtual_blue_score)
}
