use corelib::deposit::DepositFXG;

use kaspa_wallet_core::prelude::DynRpcApi;

use tracing::error;

use kaspa_wallet_core::utxo::NetworkParams;

use corelib::escrow::is_utxo_escrow_address;
use corelib::message::parse_hyperlane_metadata;
use std::str::FromStr;

use kaspa_rpc_core::{api::rpc::RpcApi, RpcBlock};
use kaspa_rpc_core::{RpcHash, RpcTransactionOutput};
use kaspa_wrpc_client::prelude::NetworkId;
use std::sync::Arc;

use eyre::Result;
use hyperlane_core::U256;

pub async fn validate_new_deposit(
    client: &Arc<DynRpcApi>,
    deposit: &DepositFXG,
    escrow_address: &str,
) -> Result<bool> {
    // TODO: call validation! Requires fix
    Ok(true)
}

async fn validate_maturity(client: &Arc<DynRpcApi>, block: &RpcBlock) -> Result<bool> {
    let network = client.get_current_network().await?;
    let network_id = NetworkId::new(network);
    let params = NetworkParams::from(network_id);

    let dag_info = client.get_block_dag_info().await?;
    if block.header.daa_score + params.user_transaction_maturity_period_daa()
        > dag_info.virtual_daa_score
    {
        return Ok(true);
    }

    Ok(false)
}

pub async fn validate_deposit(
    client: &Arc<DynRpcApi>,
    deposit: &DepositFXG,
    escrow_address: &str,
) -> Result<bool> {
    let block_hash = RpcHash::from_str(&deposit.block_id)?;
    let tx_hash = RpcHash::from_str(&deposit.tx_id)?;

    // get block from rpc
    let block: RpcBlock = client.get_block(block_hash, true).await?;

    // find tx in block
    let tx_index = block
        .verbose_data
        .as_ref()
        .ok_or("block data not found")
        .map_err(|e: &'static str| eyre::eyre!(e))?
        .transaction_ids
        .iter()
        .position(|id| id == &tx_hash)
        .ok_or("transaction not found in block")
        .map_err(|e: &'static str| eyre::eyre!(e))?;

    println!("tx index {}", tx_index);
    // get utxo in the tx from index in deposit.
    let utxo: &RpcTransactionOutput = block.transactions[tx_index]
        .outputs
        .get(deposit.utxo_index)
        .ok_or("utxo not found by index")
        .map_err(|e: &'static str| eyre::eyre!(e))?;

    // decode Hyperlane message
    let token_message = parse_hyperlane_metadata(&deposit.payload)?;

    if U256::from(utxo.value) < token_message.amount() {
        let amt = U256::from(utxo.value);
        let token_amt = token_message.amount();
        error!(
            "Deposit amount is less than token message amount, deposit: {:?}, token message: {:?}",
            amt, token_amt
        );
        return Ok(false);
    }

    let is_escrow = is_utxo_escrow_address(&utxo.script_public_key, escrow_address)?;
    if !is_escrow {
        error!(
            "Deposit is not to escrow address,escrow: {:?}",
            escrow_address
        );
        return Ok(false);
    }

    let maturity_result = validate_maturity(client, &block).await?;
    if !maturity_result {
        error!(
            "Deposit is not mature, block daa score: {:?}",
            block.header.daa_score
        );
        return Ok(false);
    }
    Ok(true)
}
