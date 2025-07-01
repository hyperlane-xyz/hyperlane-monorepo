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
use corelib::{api::deposits::Deposit, deposit::DepositFXG};
use eyre::Result;
use hyperlane_core::{Encode, RawHyperlaneMessage, U256};
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::tx::TransactionOutpoint;
pub use secp256k1::PublicKey;
use std::error::Error;
use corelib::{parse_hyperlane_message,parse_hyperlane_metadata};
use kaspa_addresses::Address;

pub async fn handle_new_deposit(deposit: &Deposit, escrow_address: &Address) -> Result<DepositFXG> {
    // decode payload into Hyperlane message
    let rawmessage: RawHyperlaneMessage = hex::decode(deposit.payload.clone()).map_err(|e| eyre::eyre!(e))?;
    let hl_message = parse_hyperlane_message(&rawmessage).map_err(|e| eyre::eyre!(e))?;

    // decode token message from Hyperlane message body
    let token_message: TokenMessage =
        parse_hyperlane_metadata(&hl_message).map_err(|e| eyre::eyre!(e))?;

    // find the index of the utxo that satisfies the transfer amount in hl message
    let utxo_index = deposit.outputs
        .iter()
        .position(|utxo: &api_rs::models::TxOutput| {
            U256::from(utxo.amount) >= token_message.amount() && utxo.script_public_key_address.clone().unwrap() == escrow_address.address_to_string()
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

#[cfg(test)]
mod tests {
    use hyperlane_core::{Encode, H256,HyperlaneMessage};
    use rand::Rng;

    use super::*;
    use std::{ops::Add, result::Result as StdResult};

    /// Helper to create a HyperlaneMessage with a serialized TokenMessage in its body.
    fn create_hyperlane_message_with_token(
        recipient: H256,
        amount: U256,
        metadata: Vec<u8>,
    ) -> HyperlaneMessage {
        let mut hl_message: HyperlaneMessage = HyperlaneMessage::default();
        let token_msg = TokenMessage::new(recipient, amount, metadata);
        let encoded_bytes = token_msg.to_vec();

        hl_message.body = encoded_bytes;

        return hl_message;
    }

    #[test]
    fn hl_message_test() {
        let message = create_hyperlane_message_with_token(H256::random(), U256::one(), vec![]);
        let result = parse_hyperlane_metadata(&message);

        assert!(
            result.is_ok(),
            "Test failed unexpectedly, error: {:?}",
            result.unwrap_err()
        );

        let token_message = result.unwrap();
        assert!(token_message.metadata().is_empty(), "should be empty");

        let mut rng = rand::thread_rng(); // Initialize the thread-local random number generator
        let mut random_bytes = vec![0u8; 10]; // Create a vector of zeros with the desired length
        rng.fill(&mut random_bytes[..]);
        let expected_bytes = random_bytes.clone();
        let message_nonempty =
            create_hyperlane_message_with_token(H256::random(), U256::one(), random_bytes);
        let result_nonempty = parse_hyperlane_metadata(&message_nonempty);

        let token_message_nonempty = result_nonempty.unwrap();
        assert!(
            !token_message_nonempty.metadata().is_empty(),
            "shouldn't be empty"
        );
        assert_eq!(expected_bytes, token_message_nonempty.metadata());
    }

}

pub async fn handle_new_deposits(
    deposits: Vec<&Deposit>,escrow_address: &Address
) -> Result<Vec<DepositFXG>, Box<dyn Error>> {
    let mut txs = Vec::new();

    for deposit in deposits {
        let tx = handle_new_deposit(deposit,escrow_address).await?;
        txs.push(tx);
    }

    Ok(txs)
}
