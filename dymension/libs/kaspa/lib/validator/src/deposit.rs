use corelib::deposit::DepositFXG;

use kaspa_wallet_core::prelude::DynRpcApi;

use relayer::deposit::ParsedHL;
use tracing::error;

use kaspa_wallet_core::utxo::NetworkParams;

use corelib::escrow::is_utxo_escrow_address;
use corelib::message::parse_hyperlane_metadata;
use std::str::FromStr;

use kaspa_rpc_core::{api::rpc::RpcApi, RpcBlock};
use kaspa_rpc_core::{RpcHash, RpcTransactionOutput};
use kaspa_wrpc_client::prelude::{NetworkId, NetworkType};
use std::sync::Arc;

use eyre::Result;
use hyperlane_core::U256;

use corelib::{confirmation::ConfirmationFXG, withdraw::WithdrawFXG};

pub async fn validate_new_deposit(
    client: &Arc<DynRpcApi>,
    deposit: &DepositFXG,
    escrow_address: &str,
    network_params: &NetworkParams,
) -> Result<bool> {
    let validation_result =
        validate_deposit(client, deposit, escrow_address, network_params).await?;
    Ok(validation_result)
}

async fn validate_maturity(
    client: &Arc<DynRpcApi>,
    block: &RpcBlock,
    network_params: &NetworkParams,
) -> Result<bool> {
    let dag_info = client.get_block_dag_info().await?;
    if block.header.daa_score + network_params.user_transaction_maturity_period_daa()
        < dag_info.virtual_daa_score
    {
        return Ok(true);
    }

    Ok(false)
}

pub async fn validate_deposit(
    client: &Arc<DynRpcApi>,
    deposit: &DepositFXG,
    escrow_address: &str,
    network_params: &NetworkParams,
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

    let deposit_tx = block.transactions[tx_index].clone();

    // get utxo in the tx from index in deposit.
    let utxo: &RpcTransactionOutput = deposit_tx
        .outputs
        .get(deposit.utxo_index)
        .ok_or("utxo not found by index")
        .map_err(|e: &'static str| eyre::eyre!(e))?;

    let original_hl_message = ParsedHL::parse_bytes(deposit_tx.payload)?.hl_message;

    // validate the relayed hl message recipient corresponds to original hl message included in the transaction
    if original_hl_message.recipient != deposit.payload.recipient {
        error!("Original HL message recipient does not correspond to relayed message. Original Id: {}. Relayed Id: {}",original_hl_message.recipient,deposit.payload.recipient);
        return Ok(false);
    }

    // decode Hyperlane message
    let token_message = parse_hyperlane_metadata(&deposit.payload)?;

    // decode original Hyperlane message
    let original_token_message = parse_hyperlane_metadata(&original_hl_message)?;

    // compare original token message values with relayed one
    if original_token_message.amount() != token_message.amount() || original_token_message.recipient() != token_message.recipient(){
        error!("Original token message does not correspond to relayed token message.");
        return Ok(false);
    }
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

    let maturity_result = validate_maturity(client, &block, network_params).await?;
    if !maturity_result {
        error!(
            "Deposit is not mature, block daa score: {:?}",
            block.header.daa_score
        );
        return Ok(false);
    }
    Ok(true)
}
