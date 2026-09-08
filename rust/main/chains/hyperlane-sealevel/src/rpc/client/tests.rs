use std::collections::HashMap;
use std::sync::Arc;

use hyperlane_core::U256;
use serde_json::{json, Value};
use solana_client::{
    client_error::ClientError, nonblocking::rpc_client::RpcClient, rpc_client::RpcClientConfig,
    rpc_request::RpcRequest,
};
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::rpc_sender::{RpcSender, RpcTransportStats};
use solana_sdk::signature::Signature;
use solana_transaction_status::TransactionDetails;

use super::{block_config, block_info_config};
use crate::client::SealevelRpcClient;
use crate::log_meta_composer::{
    is_interchain_payment_instruction, is_message_dispatch_instruction, LogMetaComposer,
};
use crate::utils::{decode_h512, decode_pubkey};

// Assert the actual serialized requests, not just the config helper.
struct ReadSender {
    request: RpcRequest,
    params: Value,
    response: Value,
}

#[async_trait::async_trait]
impl RpcSender for ReadSender {
    async fn send(&self, request: RpcRequest, params: Value) -> Result<Value, ClientError> {
        assert_eq!(request, self.request);
        assert_eq!(params, self.params);
        Ok(self.response.clone())
    }

    fn get_transport_stats(&self) -> RpcTransportStats {
        RpcTransportStats::default()
    }

    fn url(&self) -> String {
        "http://localhost:8899".to_owned()
    }
}

fn read_client(request: RpcRequest, params: Value, response: Value) -> SealevelRpcClient {
    SealevelRpcClient::from_rpc_client(Arc::new(RpcClient::new_sender(
        ReadSender {
            request,
            params,
            response,
        },
        RpcClientConfig::default(),
    )))
}

fn signature_status_client(api_version: serde_json::Value) -> SealevelRpcClient {
    let response = serde_json::json!({
        "context": {
            "slot": 42,
            "apiVersion": api_version,
        },
        "value": [null],
    });
    let mocks = HashMap::from([(RpcRequest::GetSignatureStatuses, response)]);
    SealevelRpcClient::from_rpc_client(Arc::new(RpcClient::new_mock_with_mocks(
        "succeeds".to_owned(),
        mocks,
    )))
}

//#[tokio::test]
async fn _test_get_block() {
    let rpc_client = RpcClient::new("<solana-rpc>".to_string());
    // given
    let client = SealevelRpcClient::from_rpc_client(Arc::new(rpc_client));

    // when
    let slot = 301337842; // block which requires latest version of solana-client
    let result = client.get_block(slot).await;

    // then
    assert!(result.is_ok());
}

/// Regression: getBlock must not request rewards. Our pinned solana crates
/// can't deserialize newer reward types (e.g. `DeactivatedStake`), and a
/// SerdeJson parse failure on getBlock permanently stalls the sequence-aware
/// scraper cursor. The scraper never reads rewards, so they must stay
/// disabled. See ENG-4405.
#[test]
fn get_block_config_disables_rewards() {
    let config = block_config(CommitmentConfig::finalized(), 0);

    assert_eq!(config.rewards, Some(false));
    assert_eq!(config.max_supported_transaction_version, Some(0));
    assert_eq!(config.commitment, Some(CommitmentConfig::finalized()));
}

#[test]
fn get_block_info_config_omits_transactions() {
    let config = block_info_config(CommitmentConfig::finalized());

    assert_eq!(config.transaction_details, Some(TransactionDetails::None));
    assert_eq!(config.rewards, Some(false));
}

#[tokio::test]
async fn signature_statuses_treat_empty_api_version_as_absent() {
    for search_transaction_history in [false, true] {
        let client = signature_status_client(serde_json::json!(""));
        let signatures = [Signature::default()];

        let response = if search_transaction_history {
            client
                .get_signature_statuses_with_history(&signatures)
                .await
        } else {
            client.get_signature_statuses(&signatures).await
        }
        .unwrap();

        assert_eq!(response.context.slot, 42);
        assert_eq!(response.context.api_version, None);
        assert_eq!(response.value, vec![None]);
    }
}

#[tokio::test]
async fn signature_statuses_preserve_valid_api_version() {
    let client = signature_status_client(serde_json::json!("2.1.0"));

    let response = client
        .get_signature_statuses_with_history(&[Signature::default()])
        .await
        .unwrap();

    assert_eq!(
        response
            .context
            .api_version
            .map(|version| version.to_string()),
        Some("2.1.0".to_owned())
    );
}

#[tokio::test]
async fn signature_statuses_reject_nonempty_invalid_api_version() {
    let client = signature_status_client(serde_json::json!("invalid"));

    let result = client
        .get_signature_statuses_with_history(&[Signature::default()])
        .await;

    assert!(result.is_err());
}

#[test]
fn v1_block_reads_use_json() {
    let config = block_config(CommitmentConfig::finalized(), 1);
    assert_eq!(config.max_supported_transaction_version, Some(1));
    assert_eq!(
        config.encoding,
        Some(solana_transaction_status::UiTransactionEncoding::Json)
    );
}

#[tokio::test]
async fn reads_mixed_version_json_blocks() {
    // The read path consumes JSON fields, never the v1 binary layout.
    let legacy: serde_json::Value = serde_json::from_str(include_str!(
        "../../log_meta_composer/dispatch_message_txn.json"
    ))
    .unwrap();
    let v0: Value = serde_json::from_str(include_str!(
        "../../log_meta_composer/dispatch_message_versioned_txn.json"
    ))
    .unwrap();
    let mut v1 = legacy.clone();
    v1["version"] = serde_json::json!(1);
    v1["transaction"]["message"]["transactionConfig"] = serde_json::json!({
        "computeUnitLimit": 200000,
        "priorityFee": 50000,
        "heapSize": null,
        "loadedAccountsDataSizeLimit": null
    });
    let block = serde_json::json!({
        "blockhash": "11111111111111111111111111111111",
        "previousBlockhash": "previous",
        "parentSlot": 41,
        "transactions": [v0, v1],
        "rewards": [],
        "blockTime": 1729865514,
        "blockHeight": 42
    });
    // Include legacy without creating a second matching dispatch for the same PDA.
    let mut unrelated_legacy = legacy;
    unrelated_legacy["version"] = json!("legacy");
    unrelated_legacy["transaction"]["message"]["instructions"] = json!([]);
    unrelated_legacy["meta"]["innerInstructions"] = json!([]);
    let mut block = block;
    block["transactions"]
        .as_array_mut()
        .unwrap()
        .insert(0, unrelated_legacy);
    let expected_signature = decode_h512(
        block["transactions"][2]["transaction"]["signatures"][0]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let client = read_client(
        RpcRequest::GetBlock,
        json!([42, {"encoding":"json", "commitment":"finalized", "maxSupportedTransactionVersion":1, "rewards":false, "transactionDetails":null}]),
        block,
    ).with_max_supported_transaction_version(1);
    let result = client.get_block(42).await.unwrap();
    let transactions = result.transactions.as_ref().unwrap();
    assert_eq!(transactions.len(), 3);
    assert_eq!(
        serde_json::to_value(&transactions[2]).unwrap()["version"],
        1
    );
    let program = decode_pubkey("E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi").unwrap();
    let pda = decode_pubkey("6eG8PheL41qLFFUtPjSYMtsp4aoAQsMgcsYwkGCB8kwT").unwrap();
    let meta = LogMetaComposer::new(
        program,
        "dispatch".to_owned(),
        is_message_dispatch_instruction,
    )
    .log_meta(result.clone(), U256::zero(), &pda, &42)
    .unwrap();
    assert_eq!(meta.transaction_index, 2);
    assert_eq!(meta.transaction_id, expected_signature);
    let program = decode_pubkey("BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv").unwrap();
    let pda = decode_pubkey("9yMwrDqHsbmmvYPS9h4MLPbe2biEykcL51W7qJSDL5hF").unwrap();
    let payment = LogMetaComposer::new(
        program,
        "gas payment".to_owned(),
        is_interchain_payment_instruction,
    )
    .log_meta(result, U256::zero(), &pda, &42)
    .unwrap();
    assert_eq!(payment.transaction_index, 2);
    assert_eq!(payment.transaction_id, expected_signature);
}

#[tokio::test]
async fn reads_v1_parsed_transaction_metadata() {
    let mut tx: serde_json::Value = serde_json::from_str(include_str!(
        "../../log_meta_composer/dispatch_message_txn.json"
    ))
    .unwrap();
    tx["version"] = serde_json::json!(1);
    let account_keys = tx["transaction"]["message"]["accountKeys"]
        .as_array()
        .unwrap()
        .clone();
    let partially_decode = |instruction: &Value| {
        json!({
            "programId": account_keys[instruction["programIdIndex"].as_u64().unwrap() as usize],
            "accounts": instruction["accounts"].as_array().unwrap().iter().map(|index| &account_keys[index.as_u64().unwrap() as usize]).collect::<Vec<_>>(),
            "data": instruction["data"],
            "stackHeight": instruction["stackHeight"],
        })
    };
    let message = tx["transaction"]["message"].as_object_mut().unwrap();
    let header = &message["header"];
    let signers = header["numRequiredSignatures"].as_u64().unwrap() as usize;
    let readonly_signed = header["numReadonlySignedAccounts"].as_u64().unwrap() as usize;
    let readonly_unsigned = header["numReadonlyUnsignedAccounts"].as_u64().unwrap() as usize;
    let keys = account_keys
        .iter()
        .enumerate()
        .map(|(index, key)| {
            let signer = index < signers;
            let writable = if signer {
                index < signers - readonly_signed
            } else {
                index < account_keys.len() - readonly_unsigned
            };
            json!({"pubkey": key, "signer": signer, "writable": writable, "source": "transaction"})
        })
        .collect::<Vec<_>>();
    let instructions = message["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(&partially_decode)
        .collect::<Vec<_>>();
    message.insert("instructions".into(), json!(instructions));
    message.insert("accountKeys".into(), json!(keys));
    message.remove("header");
    message.insert(
        "transactionConfig".into(),
        json!({"computeUnitLimit": 200000, "priorityFee": 50000, "heapSize":null, "loadedAccountsDataSizeLimit":null}),
    );
    for inner in tx["meta"]["innerInstructions"].as_array_mut().unwrap() {
        let instructions = inner["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .map(&partially_decode)
            .collect::<Vec<_>>();
        inner["instructions"] = json!(instructions);
    }
    tx["meta"]
        .as_object_mut()
        .unwrap()
        .remove("loadedAddresses");
    let expected_fee = tx["meta"]["fee"].as_u64().unwrap();
    let client = read_client(
        RpcRequest::GetTransaction,
        json!([Signature::default().to_string(), {"encoding":"jsonParsed", "commitment":"finalized", "maxSupportedTransactionVersion":1}]),
        tx,
    ).with_max_supported_transaction_version(1);
    let result = client.get_transaction(&Signature::default()).await.unwrap();
    assert_eq!(result.transaction.meta.unwrap().fee, expected_fee);
}

#[tokio::test]
async fn default_chain_reads_keep_version_zero() {
    let client = read_client(
        RpcRequest::GetBlock,
        json!([42, {"encoding":"json", "commitment":"finalized", "maxSupportedTransactionVersion":0, "rewards":false, "transactionDetails":null}]),
        json!({"blockhash":"hash", "previousBlockhash":"previous", "parentSlot":41, "blockTime":null, "blockHeight":42}),
    );
    client.get_block(42).await.unwrap();
    let client = read_client(
        RpcRequest::GetTransaction,
        json!([Signature::default().to_string(), {"encoding":"jsonParsed", "commitment":"finalized", "maxSupportedTransactionVersion":0}]),
        serde_json::from_str(include_str!(
            "../../log_meta_composer/dispatch_message_txn.json"
        ))
        .unwrap(),
    );
    client.get_transaction(&Signature::default()).await.unwrap();
}
