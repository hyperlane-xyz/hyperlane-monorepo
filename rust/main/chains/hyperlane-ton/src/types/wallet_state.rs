use serde::{Deserialize, Serialize};
#[derive(Debug, Serialize, Deserialize)]
pub struct WalletState {
    pub address: String,
    pub is_wallet: bool,
    pub wallet_type: String,
    pub seqno: u64,
    pub wallet_id: u64,
    pub balance: String,
    pub status: String,
    pub code_hash: String,
    pub last_transaction_hash: String,
    pub last_transaction_lt: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AddressBookEntry {
    pub user_friendly: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WalletStatesResponse {
    pub wallets: Vec<WalletState>,
    pub address_book: std::collections::HashMap<String, AddressBookEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WalletInformation {
    pub balance: String,
    pub wallet_type: String,
    pub seqno: usize,
    pub wallet_id: usize,
    pub last_transaction_lt: String,
    pub last_transaction_hash: String,
    pub status: String,
}
