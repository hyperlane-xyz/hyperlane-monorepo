pub mod confirmation;
pub mod deposit;
pub mod withdraw;
pub mod withdrawal;

use kaspa_wrpc_client::KaspaRpcClient;
pub use secp256k1::Keypair as KaspaSecpKeypair;

use core::{is_utxo_escrow_address, parse_hyperlane_metadata};
use std::error::Error;
use std::str::FromStr;

use core::deposit::DepositFXG;
use kaspa_rpc_core::{api::rpc::RpcApi, RpcHash};

use hyperlane_core::U256;

pub async fn validate_deposit(client: &KaspaRpcClient, deposit: DepositFXG) -> Result<bool, Box<dyn Error>> {
    
    let block_hash = RpcHash::from_str(&deposit.block_id)?;
    let tx_hash = RpcHash::from_str(&deposit.tx_id)?;

    // get block from rpc
    let block = client.get_block(block_hash, true).await?;

    // find tx in block
    let tx_index = block.verbose_data
        .ok_or("block data not found")?
        .transaction_ids
        .iter()
        .position(|id| id == &tx_hash)
        .ok_or("transaction not found in block")?;

    println!("tx index {}",tx_index);
    // get utxo in the tx from index in deposit.
    let utxo: &kaspa_rpc_core::RpcTransactionOutput = block.transactions[tx_index]
        .outputs
        .get(deposit.utxo_index)
        .ok_or("utxo not found by index")?;

    // decode Hyperlane message
    let token_message = parse_hyperlane_metadata(&deposit.payload)?;

    if U256::from(utxo.value) < token_message.amount() {
        return Ok(false);
    }

    let is_escrow = is_utxo_escrow_address(&utxo.script_public_key)?;

    if !is_escrow {
        return Ok(false);
    }

    //TODO: validate tx maturity.
    Ok(true)
}

