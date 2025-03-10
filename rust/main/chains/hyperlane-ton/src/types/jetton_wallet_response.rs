use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize, Serialize)]
pub struct GetJettonWalletsResponse {
    pub address_book: HashMap<String, AddressBookEntry>,
    pub jetton_wallets: Vec<JettonWalletInfo>,
    pub metadata: HashMap<String, MetadataEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AddressBookEntry {
    pub domain: Option<String>,
    pub user_friendly: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct JettonWalletInfo {
    pub address: String,
    pub balance: String,
    pub code_hash: String,
    pub data_hash: String,
    pub jetton: String,
    pub last_transaction_lt: String,
    pub mintless_info: Option<MintlessInfo>,
    pub owner: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MintlessInfo {
    pub amount: String,
    pub custom_payload_api_uri: Vec<String>,
    pub expire_at: i64,
    pub start_from: i64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct MetadataEntry {
    pub is_indexed: bool,
    pub token_info: Vec<TokenInfo>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TokenInfo {
    pub description: String,
    pub extra: HashMap<String, serde_json::Value>,
    pub image: Option<String>,
    pub name: String,
    pub symbol: String,
    #[serde(rename = "type")]
    pub token_type: String,
}
