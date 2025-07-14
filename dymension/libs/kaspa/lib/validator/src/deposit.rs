use corelib::deposit::DepositFXG;

use kaspa_wallet_core::prelude::DynRpcApi;

use tracing::error;

use kaspa_wallet_core::utxo::NetworkParams;

use corelib::message::{add_kaspa_metadata_hl_messsage, parse_hyperlane_metadata, ParsedHL};
use std::str::FromStr;

use corelib::escrow::EscrowPublic;
use corelib::wallet::NetworkInfo;
use kaspa_addresses::Address;
use kaspa_rpc_core::{api::rpc::RpcApi, RpcBlock};
use kaspa_rpc_core::{RpcHash, RpcTransactionOutput};
use kaspa_wrpc_client::prelude::{NetworkId, NetworkType};
use std::sync::Arc;

use eyre::Result;
use hyperlane_core::U256;
use kaspa_txscript::extract_script_pub_key_address;

use corelib::{confirmation::ConfirmationFXG, util, withdraw::WithdrawFXG};
use hardcode::hl::ALLOWED_HL_MESSAGE_VERSION;
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;

/// Deposit validation process
/// Executed by validators to check the deposit info relayed is equivalent to the original Kaspa tx to the escrow address
/// It validates that:
///  * The original escrow transaction exists in Kaspa network
///  * The HL message relayed is equivalent to the HL message included in the original Kaspa Tx (after recreating metadata injection to token message)
///  * The Kaspa transaction utxo destination is the escrowed address and the utxo value is enough to cover the tx.
///  * The utxo is mature
///
/// Note: If the utxo value is higher of the amount the deposit is also accepted
///
pub async fn validate_new_deposit(
    client: &Arc<DynRpcApi>,
    deposit: &DepositFXG,
    net: &NetworkInfo,
    escrow_address: &Address,
    hub_client: &CosmosGrpcClient,
) -> Result<bool> {
    let hub_bootstrapped = hub_client.hub_bootstrapped().await?;
    validate_new_deposit_inner(client, deposit, net, escrow_address, hub_bootstrapped).await
}

/// Deposit validation process
/// Executed by validators to check the deposit info relayed is equivalent to the original Kaspa tx to the escrow address
/// It validates that:
///  * The original escrow transaction exists in Kaspa network
///  * The HL message relayed is equivalent to the HL message included in the original Kaspa Tx (after recreating metadata injection to token message)
///  * The Kaspa transaction utxo destination is the escrowed address and the utxo value is enough to cover the tx.
///  * The utxo is mature
///
/// Note: If the utxo value is higher of the amount the deposit is also accepted
///
pub async fn validate_new_deposit_inner(
    client: &Arc<DynRpcApi>,
    deposit: &DepositFXG,
    net: &NetworkInfo,
    escrow_address: &Address,
    hub_bootstrapped: bool,
) -> Result<bool> {
    if !hub_bootstrapped {
        error!("Hub is not bootstrapped, cannot validate deposit");
        return Ok(false);
    }

    // convert block and tx id strings to hashes
    let block_hash = RpcHash::from_str(&deposit.block_id)?;
    let tx_hash = RpcHash::from_str(&deposit.tx_id)?;

    // get block from Kaspa node
    let block: RpcBlock = client.get_block(block_hash, true).await?;

    // validation of the Kaspa tx maturity (old enough to be accepted)
    let maturity_result =
        util::maturity::validate_maturity(client, block.header.daa_score, net.network_id).await?;
    if !maturity_result {
        error!(
            "Deposit is not mature, block daa score: {:?}",
            block.header.daa_score
        );
        return Ok(false);
    }

    // check that the HL message version is allowed
    if deposit.hl_message.version != ALLOWED_HL_MESSAGE_VERSION {
        error!("HL message version is not allowed");
        return Ok(false);
    }

    // find the relayed Kaspa Tx in block (id included in the deposit)
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

    // deposit tx retrieved from Kaspa node
    let deposit_tx = block.transactions[tx_index].clone();

    // get utxo in the tx from index in deposit.
    let utxo: &RpcTransactionOutput = deposit_tx
        .outputs
        .get(deposit.utxo_index)
        .ok_or("utxo not found by index")
        .map_err(|e: &'static str| eyre::eyre!(e))?;

    // get HLMessage and token message from Tx payload
    let parsed_hl = ParsedHL::parse_bytes(deposit_tx.payload)?;

    // deposit tx amount
    let amount: U256 = parsed_hl.token_message.amount();

    // this recreates the metadata injection to the token message done by the relayer
    let hl_message_with_tx_info =
        add_kaspa_metadata_hl_messsage(parsed_hl, tx_hash, deposit.utxo_index)?;

    // this validates the original HL message included in the Kaspa Tx its the same than the HL message relayed, after adding the metadata.
    if deposit.hl_message.id() != hl_message_with_tx_info.id() {
        error!("Relayed HL message does not match HL message included in Kaspa Tx");
        return Ok(false);
    }

    // validation the utxo amount is sufficient for the deposit
    if U256::from(utxo.value) < amount {
        error!(
            "Deposit amount is less than token message amount, deposit: {:?}, token message: {:?}",
            U256::from(utxo.value),
            amount
        );
        return Ok(false);
    }

    let utxo_addr = extract_script_pub_key_address(&utxo.script_public_key, net.address_prefix)?;
    if utxo_addr != *escrow_address {
        error!(
            "Deposit is not to escrow address, escrow: {:?}, utxo: {:?}",
            escrow_address, utxo.script_public_key
        );
        return Ok(false);
    }

    Ok(true)
}
