use crate::AptosClient;
use anyhow::{Context, Result};
use aptos_sdk::{
    move_types::language_storage::TypeTag,
    move_types::{ident_str, language_storage::ModuleId},
    rest_client::aptos_api_types::{
        EntryFunctionId, MoveType, Transaction as AptosTransaction, ViewRequest,
    },
    transaction_builder::TransactionFactory,
    types::{
        account_address::AccountAddress,
        chain_id::ChainId,
        transaction::{EntryFunction, TransactionPayload},
        LocalAccount,
    },
};
use hyperlane_core::{ChainCommunicationError, ChainResult, H256};
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

    let response = aptos_client
        .submit_and_wait(&signed_tx)
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))?
        .into_inner();
    Ok(response)
}

/// Make Aptos Transaction Payload
pub fn make_aptos_payload(
    package_address: AccountAddress,
    module_name: &'static str,
    function_name: &'static str,
    ty_args: Vec<TypeTag>,
    args: Vec<Vec<u8>>,
) -> TransactionPayload {
    TransactionPayload::EntryFunction(EntryFunction::new(
        ModuleId::new(package_address, ident_str!(module_name).to_owned()),
        ident_str!(function_name).to_owned(),
        ty_args,
        args,
    ))
}

/// Send View Request
pub async fn send_view_request(
    aptos_client: &AptosClient,
    package_address: String,
    module_name: String,
    function_name: String,
    type_arguments: Vec<MoveType>,
    arguments: Vec<serde_json::Value>,
) -> ChainResult<Vec<serde_json::Value>> {
    let view_response = aptos_client
        .view(
            &ViewRequest {
                function: EntryFunctionId::from_str(&format!(
                    "{package_address}::{module_name}::{function_name}"
                ))
                .unwrap(),
                type_arguments,
                arguments,
            },
            Option::None,
        )
        .await
        .map_err(ChainCommunicationError::from_other)?
        .into_inner();
    Ok(view_response)
}

/// Convert address string to H256
pub fn convert_addr_string_to_h256(addr: &String) -> Result<H256, String> {
    let formated_addr = format!("{:0>64}", addr.trim_start_matches("0x"));
    H256::from_str(&formated_addr).map_err(|e| e.to_string())
}
