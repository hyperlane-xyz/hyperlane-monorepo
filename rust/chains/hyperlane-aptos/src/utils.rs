
use aptos_sdk::{
  transaction_builder::TransactionFactory,
  types::{
    LocalAccount,
    chain_id::ChainId,
    transaction::{ TransactionPayload }
  },
  rest_client::aptos_api_types::Transaction as AptosTransaction
};
use crate::AptosClient;
use anyhow::{Context, Result};
use hyperlane_core::H256;
use std::str::FromStr;

/// Send Aptos Transaction
pub async fn send_aptos_transaction(
  aptos_client: &AptosClient,
  signer: &mut LocalAccount,
  payload: TransactionPayload,
) -> Result<AptosTransaction> {
        
  const GAS_LIMIT: u64 = 100000;

  let state = aptos_client
      .get_ledger_information()
      .await
      .context("Failed in getting chain id")?
      .into_inner();
  
  let transaction_factory = TransactionFactory::new(ChainId::new(state.chain_id))
          .with_gas_unit_price(100)
          .with_max_gas_amount(GAS_LIMIT);
  
  let signed_tx = signer.sign_with_transaction_builder(transaction_factory.payload(payload));

  let response = aptos_client.submit_and_wait(&signed_tx)
    .await
    .map_err(|e| anyhow::anyhow!(e.to_string()))?
    .into_inner();
  Ok(response)
}

/// Convert address string to H256
pub fn convert_addr_string_to_h256(addr: &String) -> Result<H256, String> {
  let formated_addr = format!("{:0>64}", addr.trim_start_matches("0x"));
  H256::from_str(&formated_addr).map_err(|e| e.to_string())
}