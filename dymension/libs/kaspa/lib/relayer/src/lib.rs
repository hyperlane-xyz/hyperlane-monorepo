pub mod confirmation;
pub mod deposit;
pub mod hub_to_kaspa;
pub mod withdraw;
pub mod withdraw_construction;
pub mod confirmation_test;

// Re-export the main function for easier access
pub use hub_to_kaspa::build_withdrawal_pskts;
use hyperlane_cosmos_rs::dymensionxyz::dymension::forward::HlMetadata;
use prost::Message;

use api_rs::apis::{
    configuration,
    kaspa_transactions_api::{
        get_transaction_transactions_transaction_id_get,
        GetTransactionTransactionsTransactionIdGetParams,
    },
};
use corelib::{deposit::DepositFXG, ESCROW_ADDRESS};
use eyre::Result;
use hyperlane_core::{RawHyperlaneMessage,Encode,U256};
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_hashes::Hash;
pub use secp256k1::PublicKey;
use std::error::Error;
use std::str::FromStr;
use corelib::{parse_hyperlane_message,parse_hyperlane_metadata};



fn get_tn10_config() -> configuration::Configuration {
    configuration::Configuration {
        base_path: "https://api-tn10.kaspa.org".to_string(),
        user_agent: Some("OpenAPI-Generator/a6a9569/rust".to_owned()),
        client: reqwest_middleware::ClientBuilder::new(reqwest::Client::new()).build(),
        basic_auth: None,
        oauth_access_token: None,
        bearer_access_token: None,
        api_key: None,
    }
}

pub async fn handle_new_deposit(tx: String) -> Result<DepositFXG> {
    // rpc config
    let config = get_tn10_config();

    let get_params = GetTransactionTransactionsTransactionIdGetParams {
        transaction_id: tx.clone(),
        block_hash: None,
        inputs: None,
        outputs: None,
        resolve_previous_outpoints: None,
    };
    // get transaction info using Kaspa API
    let res = get_transaction_transactions_transaction_id_get(&config, get_params).await?;
    let payload = res
        .payload
        .ok_or("Tx payload not found")
        .map_err(|e| eyre::eyre!(e))?;
    let block_ids = res
        .block_hash
        .ok_or("Block id not found")
        .map_err(|e| eyre::eyre!(e))?;

    // decode payload into Hyperlane message
    let rawmessage: RawHyperlaneMessage = hex::decode(payload).map_err(|e| eyre::eyre!(e))?;
    let hl_message = parse_hyperlane_message(&rawmessage).map_err(|e| eyre::eyre!(e))?;

    // decode token message from Hyperlane message body
    let token_message: TokenMessage =
        parse_hyperlane_metadata(&hl_message).map_err(|e| eyre::eyre!(e))?;

    // find the index of the utxo that satisfies the transfer amount in hl message
    let utxo_index = res
        .outputs
        .ok_or("no utxo found in tx")
        .map_err(|e| eyre::eyre!(e))?
        .iter()
        .position(|utxo: &api_rs::models::TxOutput| {
            U256::from(utxo.amount) >= token_message.amount() && utxo.script_public_key_address.as_ref().unwrap() == ESCROW_ADDRESS
        })
        .ok_or("no utxo found")
        .map_err(|e| eyre::eyre!(e))?;

    // builds the TransactionOutpoint to inject to hl message
    let tx_id = res
        .transaction_id
        .ok_or("tx id not found")
        .map_err(|e| eyre::eyre!(e))?;
    let tx_hash = Hash::from_str(&tx_id)?;
    let output = TransactionOutpoint {
        transaction_id: tx_hash,
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
    let token_message_new = TokenMessage::new(token_message.recipient(),token_message.amount(),metadata.encode_to_vec());
    // create message with new body
    let mut hl_message_new = hl_message.clone();
    hl_message_new.body = token_message_new.to_vec();

    // build response for validator
    let tx = DepositFXG {
        msg_id: hl_message_new.id(),
        tx_id: tx,
        utxo_index: utxo_index,
        amount: token_message.amount(),
        block_id: block_ids[0].clone(),
        payload: hl_message_new,
    };
    Ok(tx)
}

#[cfg(test)]
mod tests {
    use hyperlane_core::{Encode, H256};
    use rand::Rng;

    use super::*;
    use std::result::Result as StdResult;

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

    #[tokio::test]
    async fn handle_not_enough_deposit_test() {
        let tx = "55527daf602fd41607aaf11ad56a326f63732c3691396c29ed0f4733bdda9c29";
        let result: StdResult<DepositFXG, eyre::Error> = handle_new_deposit(tx.to_string()).await;
        assert!(result.is_err(), "result should fail");
    }
}

pub async fn handle_new_deposits(
    transaction_ids: Vec<String>,
) -> Result<Vec<DepositFXG>, Box<dyn Error>> {
    let mut txs = Vec::new();

    for transaction in transaction_ids {
        let tx = handle_new_deposit(transaction).await?;
        txs.push(tx);
    }

    Ok(txs)
}
