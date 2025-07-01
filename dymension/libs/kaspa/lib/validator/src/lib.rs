pub mod confirmation;
pub mod deposit;
pub mod withdraw;
pub mod withdrawal;

use kaspa_wallet_core::{prelude::DynRpcApi, utxo::NetworkParams};
pub use secp256k1::Keypair as KaspaSecpKeypair;

use core::{is_utxo_escrow_address, parse_hyperlane_metadata};
use std::error::Error;
use std::str::FromStr;

use core::deposit::DepositFXG;
use kaspa_addresses::Prefix;
use kaspa_consensus_core::Hash;
use kaspa_rpc_core::{api::rpc::RpcApi, RpcBlock, RpcScriptPublicKey};
use kaspa_txscript::extract_script_pub_key_address;
use kaspa_wrpc_client::{
    client::{ConnectOptions, ConnectStrategy},
    prelude::{NetworkId, NetworkType},
    KaspaRpcClient, Resolver, WrpcEncoding,
};
pub mod signer;
use kaspa_rpc_core::{RpcHash, RpcTransactionOutput};
use std::sync::Arc;

use eyre::Result;
use hyperlane_core::U256;

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

pub async fn validate_deposit(client: &Arc<DynRpcApi>, deposit: &DepositFXG) -> Result<bool> {
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
    let token_message = parse_hyperlane_metadata(&deposit.payload).map_err(|e| eyre::eyre!(e))?;

    if U256::from(utxo.value) < token_message.amount() {
        return Ok(false);
    }

    let is_escrow = is_utxo_escrow_address(&utxo.script_public_key).map_err(|e| eyre::eyre!(e))?;

    if !is_escrow {
        return Ok(false);
    }

    let maturity_result = validate_maturity(client, &block).await?;
    if !maturity_result {
        return Ok(false);
    }
    Ok(true)
}

pub async fn validate_deposits(
    client: &Arc<DynRpcApi>,
    deposits: Vec<&DepositFXG>,
) -> Result<Vec<bool>, Box<dyn Error>> {
    let mut results: Vec<bool> = vec![];
    // iterate over all deposits and validate one by one
    for deposit in deposits {
        let result = validate_deposit(client, deposit).await?;
        results.push(result);
    }
    Ok(results)
}
