use serde::{Deserialize, Serialize};

/// Response from `/getnowblock` and `/getblockbynum`
#[derive(Debug, Deserialize)]
pub struct BlockResponse {
    /// Block ID (hex string)
    #[serde(rename = "blockID")]
    pub block_id: String,
    /// Block header
    pub block_header: BlockHeaderResp,
}

/// Block header wrapper
#[derive(Debug, Deserialize)]
pub struct BlockHeaderResp {
    /// Raw data of block header
    pub raw_data: BlockHeaderRawData,
}

/// Block header raw data
#[derive(Debug, Deserialize)]
pub struct BlockHeaderRawData {
    /// Block number
    pub number: i64,
    /// Block timestamp in milliseconds
    pub timestamp: i64,
}

/// Response from `/triggerconstantcontract`
#[derive(Debug, Deserialize)]
pub struct TriggerConstantResponse {
    /// Hex-encoded return values
    #[serde(default)]
    pub constant_result: Vec<String>,
    /// Result of the call (contains error info on failure)
    pub result: Option<EstimateResult>,
}

/// Response from `/wallet/estimateenergy`
#[derive(Debug, Deserialize)]
pub struct EstimateEnergyResponse {
    /// Energy required (may be absent on estimation failure)
    #[serde(default)]
    pub energy_required: i64,
    /// Result of the estimation
    pub result: Option<EstimateResult>,
}

/// Nested result field in estimate energy response
#[derive(Debug, Deserialize)]
pub struct EstimateResult {
    /// Error code (present on failure)
    pub code: Option<String>,
    /// Error message (hex-encoded on failure)
    pub message: Option<String>,
}

/// Response from `/wallet/broadcasthex`
#[derive(Debug, Deserialize)]
pub struct BroadcastResponse {
    /// Whether the broadcast was successful
    pub result: Option<bool>,
    /// Error code
    pub code: Option<String>,
    /// Error message
    pub message: Option<String>,
}

/// Request body for `/triggerconstantcontract` and `/estimateenergy`
#[derive(Debug, Clone, Serialize)]
pub struct TriggerContractRequest {
    /// Owner address (hex with 41 prefix)
    pub owner_address: String,
    /// Contract address (hex with 41 prefix)
    pub contract_address: String,
    /// Hex-encoded calldata (without 0x prefix)
    pub data: String,
    /// Call value
    pub call_value: i64,
    /// Always false (hex addresses)
    pub visible: bool,
}
