use std::collections::HashMap;
use std::sync::Arc;

use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_request::RpcRequest;
use solana_commitment_config::CommitmentConfig;
use solana_sdk::signature::Signature;
use solana_transaction_status::TransactionDetails;

use super::{block_config, block_info_config};
use crate::client::SealevelRpcClient;

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
    let mut v1 = legacy.clone();
    v1["version"] = serde_json::json!(1);
    v1["transaction"]["message"]["transactionConfig"] = serde_json::json!({
        "computeUnitLimit": 200000,
        "priorityFee": 50000,
        "heapSize": null,
        "loadedAccountsDataSizeLimit": null
    });
    let block = serde_json::json!({
        "blockhash": "blockhash",
        "previousBlockhash": "previous",
        "parentSlot": 41,
        "transactions": [legacy, v1],
        "rewards": [],
        "blockTime": 1729865514,
        "blockHeight": 42
    });
    let client = SealevelRpcClient::from_rpc_client(Arc::new(RpcClient::new_mock_with_mocks(
        "succeeds".to_owned(),
        HashMap::from([(RpcRequest::GetBlock, block)]),
    )))
    .with_max_supported_transaction_version(1);
    let result = client.get_block(42).await.unwrap();
    let transactions = result.transactions.unwrap();
    assert_eq!(transactions.len(), 2);
    assert_eq!(
        serde_json::to_value(&transactions[1]).unwrap()["version"],
        1
    );
}

#[tokio::test]
async fn reads_v1_parsed_transaction_metadata() {
    let mut tx: serde_json::Value = serde_json::from_str(include_str!(
        "../../log_meta_composer/dispatch_message_txn.json"
    ))
    .unwrap();
    tx["version"] = serde_json::json!(1);
    let message = tx["transaction"]["message"].as_object_mut().unwrap();
    let keys = message["accountKeys"].as_array().unwrap().iter().enumerate().map(|(index, key)| {
        serde_json::json!({"pubkey": key, "signer": index == 0, "writable": true, "source": "transaction"})
    }).collect::<Vec<_>>();
    message.insert("accountKeys".into(), serde_json::json!(keys));
    message.remove("header");
    message.insert(
        "transactionConfig".into(),
        serde_json::json!({"computeUnitLimit": 200000, "priorityFee": 50000}),
    );
    let expected_fee = tx["meta"]["fee"].as_u64().unwrap();
    let client = SealevelRpcClient::from_rpc_client(Arc::new(RpcClient::new_mock_with_mocks(
        "succeeds".to_owned(),
        HashMap::from([(RpcRequest::GetTransaction, tx)]),
    )))
    .with_max_supported_transaction_version(1);
    let result = client.get_transaction(&Signature::default()).await.unwrap();
    assert_eq!(result.transaction.meta.unwrap().fee, expected_fee);
}
