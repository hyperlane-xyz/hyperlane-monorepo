use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct AccountStateResponse {
    pub accounts: Vec<Account>,
    pub address_book: HashMap<String, Address>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Account {
    pub account_state_hash: Option<String>,
    pub address: Option<String>,
    pub balance: Option<String>,
    pub code_boc: Option<String>,
    pub code_hash: Option<String>,
    pub data_boc: Option<String>,
    pub data_hash: Option<String>,
    pub frozen_hash: Option<String>,
    pub last_transaction_hash: Option<String>,
    pub last_transaction_lt: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Address {
    pub user_friendly: Option<String>,
}
