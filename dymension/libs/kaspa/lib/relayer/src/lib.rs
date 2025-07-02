pub mod confirmation;
pub mod confirmation_test;
pub mod deposit;
pub mod hub_to_kaspa;
pub mod withdraw;
pub mod withdraw_construction;
use tracing::info;

// Re-export the main function for easier access
pub use hub_to_kaspa::build_withdrawal_pskt;
use hyperlane_cosmos_rs::dymensionxyz::dymension::forward::HlMetadata;
use prost::Message;

use corelib::message::{parse_hyperlane_message, parse_hyperlane_metadata};
use corelib::{api::deposits::Deposit, deposit::DepositFXG};
use eyre::Result;
use hyperlane_core::{Encode, HyperlaneMessage, RawHyperlaneMessage, U256};
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::tx::TransactionOutpoint;
pub use secp256k1::PublicKey;
use std::error::Error;

struct ParsedHL {
    hl_message: HyperlaneMessage,
    token_message: TokenMessage,
}

impl ParsedHL {
    fn parse(payload: &str) -> Result<Self> {
        let raw = hex::decode(payload)?;
        let hl_message = parse_hyperlane_message(&raw)?;
        let token_message = parse_hyperlane_metadata(&hl_message)?;
        Ok(ParsedHL {
            hl_message,
            token_message,
        })
    }
}

pub async fn handle_new_deposit(escrow_address: &str, deposit: &Deposit) -> Result<DepositFXG> {
    // decode payload into Hyperlane message

    let payload = deposit.payload.clone().unwrap();
    let parsed = ParsedHL::parse(&payload)?;
    info!(
        "Dymension, parsed new deposit HL message: {:?}",
        parsed.hl_message
    );

    let hl_message = parsed.hl_message;
    let token_message = parsed.token_message;

    // find the index of the utxo that satisfies the transfer amount in hl message
    let utxo_index = deposit
        .outputs
        .iter()
        .position(|utxo: &api_rs::models::TxOutput| {
            U256::from(utxo.amount) >= token_message.amount()
                && utxo.script_public_key_address.as_ref().unwrap() == escrow_address
        })
        .ok_or("no utxo found")
        .map_err(|e| eyre::eyre!(e))?;

    let output = TransactionOutpoint {
        transaction_id: deposit.id,
        index: utxo_index as u32,
    };
    let output_bytes = bincode::serialize(&output)?;

    let mut metadata: HlMetadata;
    if token_message.metadata().is_empty() {
        metadata = HlMetadata {
            hook_forward_to_ibc: Vec::new(),
            kaspa: output_bytes,
        };
    } else {
        metadata = HlMetadata::decode(token_message.metadata())?;
        // replace kaspa value and reencode message
        metadata.kaspa = output_bytes;
    }
    let token_message_new = TokenMessage::new(
        token_message.recipient(),
        token_message.amount(),
        metadata.encode_to_vec(),
    );
    // create message with new body
    let mut hl_message_new = hl_message.clone();
    hl_message_new.body = token_message_new.to_vec();

    // build response for validator
    let tx = DepositFXG {
        msg_id: hl_message_new.id(),
        tx_id: deposit.id.to_string(),
        utxo_index: utxo_index,
        amount: token_message.amount(),
        block_id: deposit.block_hash[0].clone(), // used by validator to find tx by block
        payload: hl_message_new,
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
            let parsed = ParsedHL::parse(input);
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
