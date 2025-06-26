pub mod confirmation;
pub mod deposit;
pub mod hub_to_kaspa_builder;
pub mod withdraw;
pub mod withdraw_construction;

// Re-export the main function for easier access
pub use hub_to_kaspa_builder::build_kaspa_withdrawal_pskts;
use hyperlane_cosmos_rs::dymensionxyz::dymension::forward::HlMetadata;
use prost::Message;

use api_rs::apis::{
    configuration,
    kaspa_transactions_api::{
        get_transaction_transactions_transaction_id_get,
        GetTransactionTransactionsTransactionIdGetParams,
    },
};
use corelib::deposit::DepositFXG;
use eyre::Result;
use hyperlane_core::Decode;
use hyperlane_core::HyperlaneMessage;
use hyperlane_core::RawHyperlaneMessage;
use hyperlane_core::U256;
use hyperlane_warp_route::TokenMessage;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_hashes::Hash;
use std::error::Error;
use std::io::Cursor;
use std::str::FromStr;

fn parse_hyperlane_message(m: &RawHyperlaneMessage) -> Result<HyperlaneMessage, anyhow::Error> {
    const MIN_EXPECTED_LENGTH: usize = 77;

    if m.len() < MIN_EXPECTED_LENGTH {
        return Err(anyhow::Error::msg("Value cannot be zero."));
    }
    let message = HyperlaneMessage::from(m);

    Ok(message)
}

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
    let block_id = res
        .accepting_block_hash
        .ok_or("Block id not found")
        .map_err(|e| eyre::eyre!(e))?;

    // decode payload into Hyperlane message
    let rawmessage: RawHyperlaneMessage = hex::decode(payload).map_err(|e| eyre::eyre!(e))?;
    let mut message = parse_hyperlane_message(&rawmessage).map_err(|e| eyre::eyre!(e))?;

    // decode token message inside  Hyperlane message
    let mut reader = Cursor::new(message.body.as_slice());
    let token_message = TokenMessage::read_from(&mut reader)?;

    // find the index of the utxo that satisfies the transfer amount in hl message
    let utxo_index = res
        .outputs
        .ok_or("no utxo found in tx")
        .map_err(|e| eyre::eyre!(e))?
        .iter()
        .position(|utxo: &api_rs::models::TxOutput| {
            U256::from(utxo.amount) >= U256::one()
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
        metadata = HlMetadata{
            hook_forward_to_ibc: Vec::new(),
            kaspa: output_bytes,
        };
    } else {
        metadata = HlMetadata::decode(token_message.metadata())?;
        // replace kaspa value and reencode message
        metadata.kaspa = output_bytes;

    }
    let body: Vec<u8> = metadata.encode_to_vec();
    message.body = body;

    // build response for validator
    let tx = DepositFXG {
        msg_id: message.id(),
        tx_id: tx,
        utxo_index: utxo_index,
        block_id: block_id,
        payload: message,
    };
    Ok(tx)
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


#[cfg(test)]
mod tests {
    use super::*; 
    use bytes::Bytes;
    use std::result::Result as StdResult;
    use eyre::Result as EyreResult;

    #[tokio::test]
    async fn handle_new_deposit_test() {
        
        let tx = "0f5d30f68cc86a6d94550c7704b7e8f02ab9e8476a2b0615ba899bad7003908b";

        let result: StdResult<DepositFXG, eyre::Error> = handle_new_deposit(tx.to_string()).await;

        assert!(result.is_ok(), "Test failed unexpectedly, error: {:?}", result.unwrap_err());
    }

}