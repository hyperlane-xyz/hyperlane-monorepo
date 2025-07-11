use corelib::deposit::DepositFXG;
use corelib::{api::client::Deposit, message::add_kaspa_metadata_hl_messsage};
use eyre::Result;

use tracing::info;

// Re-export the main function for easier access
use hyperlane_cosmos_rs::dymensionxyz::dymension::forward::HlMetadata;
use prost::Message;

use corelib::message::{parse_hyperlane_message, parse_hyperlane_metadata, ParsedHL};
use hyperlane_core::{Encode, HyperlaneMessage, RawHyperlaneMessage, U256};
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::tx::TransactionOutpoint;
pub use secp256k1::PublicKey;
use std::error::Error;

pub async fn handle_new_deposit(escrow_address: &str, deposit: &Deposit) -> Result<DepositFXG> {
    // decode payload into Hyperlane message

    let payload = deposit.payload.clone().unwrap();
    let parsed_hl = ParsedHL::parse_string(&payload)?;
    info!(
        "Dymension, parsed new deposit HL message: {:?}",
        parsed_hl.hl_message
    );

    let amount = parsed_hl.token_message.amount();
    // find the index of the utxo that satisfies the transfer amount in hl message
    let utxo_index = deposit
        .outputs
        .iter()
        .position(|utxo: &api_rs::models::TxOutput| {
            U256::from(utxo.amount) >= amount
                && utxo.script_public_key_address.as_ref().unwrap() == escrow_address
        })
        .ok_or(eyre::eyre!("kaspa deposit had insufficient sompi amount"))?;

    let hl_message_new = add_kaspa_metadata_hl_messsage(parsed_hl, deposit.id, utxo_index)?;

    // build response for validator
    let tx = DepositFXG {
        tx_id: deposit.id.to_string(),
        utxo_index: utxo_index,
        amount: amount,
        block_id: deposit.block_hash[0].clone(), // used by validator to find tx by block
        hl_message: hl_message_new,
    };
    Ok(tx)
}

pub async fn handle_new_deposits(
    deposits: Vec<&Deposit>,
    escrow_address: &str,
) -> Result<Vec<DepositFXG>, Box<dyn Error>> {
    let mut txs = Vec::new();

    for deposit in deposits {
        if deposit.payload.is_none() {
            continue;
        }
        let tx = handle_new_deposit(escrow_address, deposit).await?;
        txs.push(tx);
    }

    Ok(txs)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_parsed_hl_parse() {
        let inputs = [
            "030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000029956d5fc7253fde73070a965c50051e03437fda8f657fdd8fb5926c402bf7520000000000000000000000000000000000000000000000000000000005f5e100",
            "030000000004d10892ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff804b267ca0726f757465725f6170700000000000000000000000000002000000000000000000000000000000000000000089760f514dcfcccf1e4c5edc6bf6041931c4c18300000000000000000000000000000000000000000000000000000000000003e8",
        ];
        for input in inputs {
            let parsed = ParsedHL::parse_string(input);
            match parsed {
                Ok(parsed) => {
                    println!("hl_message: {:?}", parsed.hl_message);
                    println!("token_message: {:?}", parsed.token_message);
                }
                Err(e) => {
                    panic!("parse error: {:?}", e);
                }
            }
        }
    }
}

pub async fn on_new_deposit(escrow_address: &str, deposit: &Deposit) -> Result<Option<DepositFXG>> {
    let deposit_tx_result = handle_new_deposit(escrow_address, deposit).await?;
    Ok(Some(deposit_tx_result))
}
