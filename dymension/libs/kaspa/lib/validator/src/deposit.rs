use corelib::deposit::DepositFXG;

use kaspa_wallet_core::prelude::DynRpcApi;

use tracing::error;

use kaspa_wallet_core::utxo::NetworkParams;

use corelib::message::{add_kaspa_metadata_hl_messsage, parse_hyperlane_metadata, ParsedHL};
use std::str::FromStr;

use corelib::escrow::EscrowPublic;
use corelib::finality;
use corelib::wallet::NetworkInfo;
use kaspa_addresses::Address;
use kaspa_rpc_core::{api::rpc::RpcApi, RpcBlock};
use kaspa_rpc_core::{RpcHash, RpcTransaction, RpcTransactionOutput};
use kaspa_wrpc_client::prelude::{NetworkId, NetworkType};
use std::sync::Arc;

use eyre::Result;
use hyperlane_core::U256;
use kaspa_txscript::extract_script_pub_key_address;

use corelib::api::client::HttpClient;
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
    client_node: &Arc<DynRpcApi>,
    client_rest: &HttpClient,
    deposit: &DepositFXG,
    net: &NetworkInfo,
    escrow_address: &Address,
    hub_client: &CosmosGrpcClient,
) -> Result<bool> {
    let hub_bootstrapped = hub_client.hub_bootstrapped().await?;
    validate_new_deposit_inner(
        client_node,
        client_rest,
        deposit,
        net,
        escrow_address,
        hub_bootstrapped,
    )
    .await
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
    client_node: &Arc<DynRpcApi>,
    client_rest: &HttpClient,
    d_untrusted: &DepositFXG,
    net: &NetworkInfo,
    escrow_address: &Address,
    hub_bootstrapped: bool,
) -> Result<bool> {
    if !hub_bootstrapped {
        error!("Hub is not bootstrapped, cannot validate deposit");
        return Ok(false);
    }

    if !finality::is_safe_against_reorg(
        client_rest,
        &d_untrusted.tx_id,
        Some(d_untrusted.containing_block_hash_rpc()?.to_string()),
    )
    .await?
    {
        error!("Deposit is not sufficiently final",);
        return Ok(false);
    }

    if !d_untrusted.tx_hash_rpc().is_ok() {
        error!("Deposit tx hash is not valid");
        return Ok(false);
    }

    // check that the HL message version is allowed
    if d_untrusted.hl_message.version != ALLOWED_HL_MESSAGE_VERSION {
        error!("HL message version is not allowed");
        return Ok(false);
    }

    let containing_block: RpcBlock = client_node
        .get_block(d_untrusted.containing_block_hash_rpc()?, true)
        .await?;

    let actual_deposit = tx_by_id(&containing_block, &d_untrusted.tx_hash_rpc().unwrap())?;

    // get utxo in the tx from index in deposit.
    let actual_deposit_utxo: &RpcTransactionOutput = actual_deposit
        .outputs
        .get(d_untrusted.utxo_index)
        .ok_or("utxo not found by index")
        .map_err(|e: &'static str| eyre::eyre!(e))?;

    // get HLMessage and token message from Tx payload
    let actual_hl_message = ParsedHL::parse_bytes(actual_deposit.payload)?;

    // deposit tx amount
    let actual_hl_amt: U256 = actual_hl_message.token_message.amount();

    // recreate the metadata injection to the token message done by the relayer
    let actual_hl_message_with_injected_info = add_kaspa_metadata_hl_messsage(
        actual_hl_message,
        d_untrusted.tx_hash_rpc()?,
        d_untrusted.utxo_index,
    )?;

    // validate the original HL message included in the Kaspa Tx its the same than the HL message relayed, after adding the metadata.
    if d_untrusted.hl_message.id() != actual_hl_message_with_injected_info.id() {
        error!("Relayed HL message does not match HL message included in Kaspa Tx");
        return Ok(false);
    }

    // deposit covers HL message amount?
    if U256::from(actual_deposit_utxo.value) < actual_hl_amt {
        error!(
            "Deposit amount is less than token message amount, deposit: {:?}, token message: {:?}",
            U256::from(actual_deposit_utxo.value),
            actual_hl_amt
        );
        return Ok(false);
    }

    let actual_utxo_addr =
        extract_script_pub_key_address(&actual_deposit_utxo.script_public_key, net.address_prefix)?;
    if actual_utxo_addr != *escrow_address {
        error!(
            "Deposit is not to escrow address, escrow: {:?}, utxo: {:?}",
            escrow_address, actual_deposit_utxo.script_public_key
        );
        return Ok(false);
    }

    Ok(true)
}

/// takes block and tx id and returns the tx
fn tx_by_id(block: &RpcBlock, tx_id: &RpcHash) -> Result<RpcTransaction> {
    let tx_index_actual = block
        .verbose_data
        .as_ref()
        .ok_or("block data not found")
        .map_err(|e: &'static str| eyre::eyre!(e))?
        .transaction_ids
        .iter()
        .position(|id| id == tx_id)
        .ok_or("transaction not found in block")
        .map_err(|e: &'static str| eyre::eyre!(e))?;

    Ok(block.transactions[tx_index_actual].clone())
}
