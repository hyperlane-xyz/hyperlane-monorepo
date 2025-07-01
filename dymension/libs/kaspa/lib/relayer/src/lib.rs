pub mod confirmation;
pub mod confirmation_test;
pub mod deposit;
pub mod hub_to_kaspa;
pub mod withdraw;
pub mod withdraw_construction;

// Re-export the main function for easier access
pub use hub_to_kaspa::build_withdrawal_pskts;
use hyperlane_cosmos_rs::dymensionxyz::dymension::forward::HlMetadata;
use prost::Message;

use corelib::{api::deposits::Deposit, deposit::DepositFXG, ESCROW_ADDRESS};
use corelib::{parse_hyperlane_message, parse_hyperlane_metadata};
use eyre::Result;
use hyperlane_core::{Encode, RawHyperlaneMessage, U256};
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::tx::TransactionOutpoint;
pub use secp256k1::PublicKey;
use std::error::Error;

pub async fn handle_new_deposit(deposit: &Deposit) -> Result<DepositFXG> {
    // decode payload into Hyperlane message
    let rawmessage: RawHyperlaneMessage =
        hex::decode(deposit.payload.clone()).map_err(|e| eyre::eyre!(e))?;
    let hl_message = parse_hyperlane_message(&rawmessage).map_err(|e| eyre::eyre!(e))?;

    // decode token message from Hyperlane message body
    let token_message: TokenMessage =
        parse_hyperlane_metadata(&hl_message).map_err(|e| eyre::eyre!(e))?;

    // find the index of the utxo that satisfies the transfer amount in hl message
    let utxo_index = deposit
        .outputs
        .iter()
        .position(|utxo: &api_rs::models::TxOutput| {
            U256::from(utxo.amount) >= token_message.amount()
                && utxo.script_public_key_address.as_ref().unwrap() == ESCROW_ADDRESS
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
) -> Result<Vec<DepositFXG>, Box<dyn Error>> {
    let mut txs = Vec::new();

    for deposit in deposits {
        let tx = handle_new_deposit(deposit).await?;
        txs.push(tx);
    }

    Ok(txs)
}
