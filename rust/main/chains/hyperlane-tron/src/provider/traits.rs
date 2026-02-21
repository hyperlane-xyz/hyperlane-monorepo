use std::ops::Deref;

use async_trait::async_trait;
use derive_new::new;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use url::Url;

use hyperlane_core::ChainResult;

use crate::HyperlaneTronError;

/// Tron Http Client trait alias
pub trait TronClient: HttpClient + Clone + std::fmt::Debug + Send + Sync + 'static {}
impl<T> TronClient for T where T: HttpClient + Clone + std::fmt::Debug + Send + Sync + 'static {}

/// Builder trait for creating HTTP clients
pub trait HttpClientBuilder {
    /// The client type to build
    type Client: HttpClient;
    /// Build a client from a URL
    fn build(url: Url) -> ChainResult<Self::Client>;
}

#[async_trait]
/// HttpClient trait defines the base layer that Tron provider will use
pub trait HttpClient {
    /// Makes a POST request to the API
    async fn request_post<T: DeserializeOwned + Send>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> ChainResult<T>;
}

// ---- REST response types ----

/// Block response from Tron REST API
#[derive(Deserialize, Debug)]
pub struct BlockResponse {
    /// Block ID (hex hash)
    #[serde(rename = "blockID")]
    pub block_id: String,
    /// Block header
    pub block_header: BlockHeaderResponse,
}

/// Block header response
#[derive(Deserialize, Debug)]
pub struct BlockHeaderResponse {
    /// Raw data
    pub raw_data: BlockHeaderRawData,
}

/// Block header raw data
#[derive(Deserialize, Debug)]
pub struct BlockHeaderRawData {
    /// Block number
    pub number: u64,
    /// Timestamp in milliseconds
    pub timestamp: u64,
}

/// Result from trigger_constant_contract
#[derive(Deserialize, Debug)]
pub struct TriggerConstantResult {
    /// Constant result (hex-encoded return data)
    pub constant_result: Vec<String>,
    /// Result status
    pub result: TriggerResultStatus,
}

/// Result status for trigger_constant_contract
#[derive(Deserialize, Debug)]
pub struct TriggerResultStatus {
    /// Whether the call succeeded
    pub result: bool,
    /// Error message if failed (hex-encoded)
    pub message: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct EstimateEnergyResultStatus {
    /// Whether the estimation succeeded
    pub result: bool,
    /// Error code if failed
    pub code: Option<String>,
    /// Error message if failed (hex-encoded)
    pub message: Option<String>,
}

/// Result from estimate_energy
#[derive(Deserialize, Debug)]
pub struct EstimateEnergyResponse {
    /// Energy required
    pub energy_required: u64,
    /// Result status
    pub result: EstimateEnergyResultStatus,
}

/// Transaction returned by trigger_smart_contract
#[derive(Deserialize, Debug)]
pub struct TronTransaction {
    /// Transaction ID (hex)
    #[serde(rename = "txID")]
    pub tx_id: String,
    /// Raw data (JSON object required for broadcast)
    pub raw_data: serde_json::Value,
    /// Raw data hex
    pub raw_data_hex: String,
}

/// Result from trigger_smart_contract (wallet/triggersmartcontract)
#[derive(Deserialize, Debug)]
pub struct TriggerSmartContractResult {
    /// The unsigned transaction
    pub transaction: TronTransaction,
    /// Result status
    pub result: TriggerResultStatus,
}

/// Result from broadcast_transaction
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct BroadcastResult {
    /// Whether the broadcast succeeded
    pub result: Option<bool>,
    /// Error code if failed
    pub code: Option<String>,
    /// Transaction ID
    pub txid: Option<String>,
    /// Error message if failed
    pub message: Option<String>,
}

/// Parsed transaction parameters (hex strings, no protobuf)
pub struct TxParams {
    pub owner_hex: String,
    pub contract_hex: String,
    pub data_hex: String,
    pub call_value: u64,
}

// ---- TronRpcClient: high-level RPC wrapper ----

/// Implements high-level Tron REST API methods based on a raw HttpClient
#[derive(Debug, Clone, new)]
pub struct TronRpcClient<Client: HttpClient>(Client);

impl<T: HttpClient> Deref for TronRpcClient<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<Client: HttpClient> TronRpcClient<Client> {
    /// Get the latest block (from solidity node)
    pub async fn get_now_block(&self) -> ChainResult<BlockResponse> {
        self.request_post("walletsolidity/getnowblock", &serde_json::json!({}))
            .await
    }

    /// Get a block by number (from solidity node)
    pub async fn get_block_by_num(&self, num: u64) -> ChainResult<BlockResponse> {
        self.request_post(
            "walletsolidity/getblockbynum",
            &serde_json::json!({"num": num}),
        )
        .await
    }

    /// Call a constant contract method (read-only, from solidity node)
    pub async fn trigger_constant_contract(
        &self,
        owner_address: &str,
        contract_address: &str,
        data: &str,
    ) -> ChainResult<TriggerConstantResult> {
        let body = serde_json::json!({
            "owner_address": owner_address,
            "contract_address": contract_address,
            "function_selector": "",
            "parameter": "",
            "data": data,
            "visible": false,
        });
        let result: TriggerConstantResult = self
            .request_post("walletsolidity/triggerconstantcontract", &body)
            .await?;
        if !result.result.result {
            let msg = result
                .result
                .message
                .as_deref()
                .and_then(|m| hex::decode(m).ok())
                .and_then(|b| String::from_utf8(b).ok())
                .unwrap_or_else(|| "unknown error".to_string());
            return Err(HyperlaneTronError::RestApiError(format!(
                "trigger_constant_contract failed: {msg}"
            ))
            .into());
        }
        Ok(result)
    }

    /// Estimate energy for a contract call (from full node)
    pub async fn estimate_energy(
        &self,
        owner_address: &str,
        contract_address: &str,
        data: &str,
    ) -> ChainResult<EstimateEnergyResponse> {
        let body = serde_json::json!({
            "owner_address": owner_address,
            "contract_address": contract_address,
            "function_selector": "",
            "parameter": "",
            "data": data,
            "visible": false,
        });
        self.request_post("wallet/estimateenergy", &body).await
    }

    /// Build an unsigned transaction via trigger_smart_contract (full node)
    pub async fn trigger_smart_contract(
        &self,
        owner_address: &str,
        contract_address: &str,
        data: &str,
        call_value: u64,
        fee_limit: u64,
    ) -> ChainResult<TriggerSmartContractResult> {
        let body = serde_json::json!({
            "owner_address": owner_address,
            "contract_address": contract_address,
            "function_selector": "",
            "parameter": "",
            "data": data,
            "call_value": call_value,
            "fee_limit": fee_limit,
            "visible": false,
        });
        let result: TriggerSmartContractResult = self
            .request_post("wallet/triggersmartcontract", &body)
            .await?;
        if !result.result.result {
            let msg = result
                .result
                .message
                .as_deref()
                .and_then(|m| hex::decode(m).ok())
                .and_then(|b| String::from_utf8(b).ok())
                .unwrap_or_else(|| "unknown error".to_string());
            return Err(HyperlaneTronError::RestApiError(format!(
                "trigger_smart_contract failed: {msg}"
            ))
            .into());
        }
        Ok(result)
    }

    /// Broadcast a signed transaction
    pub async fn broadcast_transaction(
        &self,
        tx: &TronTransaction,
        signature: Vec<u8>,
    ) -> ChainResult<BroadcastResult> {
        let body = serde_json::json!({
            "visible": false,
            "txID": tx.tx_id,
            "raw_data": tx.raw_data,
            "raw_data_hex": tx.raw_data_hex,
            "signature": [hex::encode(&signature)],
        });

        self.request_post("wallet/broadcasttransaction", &body)
            .await
    }
}
