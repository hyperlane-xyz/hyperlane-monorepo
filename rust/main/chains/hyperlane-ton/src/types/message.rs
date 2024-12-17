use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct MessageResponse {
    pub address_book: Option<HashMap<String, Address>>,
    pub messages: Vec<Message>,
}

#[derive(Debug, Deserialize)]
pub struct Address {
    #[serde(rename = "user_friendly")]
    pub user_friendly: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Message {
    pub bounce: Option<bool>,
    pub bounced: Option<bool>,
    pub created_at: String,
    pub created_lt: String,
    pub destination: Option<String>,
    pub fwd_fee: Option<String>,
    pub hash: String,
    pub ihr_disabled: Option<bool>,
    pub ihr_fee: Option<String>,
    pub import_fee: Option<String>,
    pub init_state: Option<MessageContent>,
    pub message_content: MessageContent,
    pub opcode: Option<String>,
    pub source: Option<String>,
    pub value: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MessageContent {
    pub body: String,
    pub decoded: Option<DecodedMessage>,
    pub hash: String,
}

#[derive(Debug, Deserialize)]
pub struct DecodedMessage {
    pub comment: Option<String>,
    #[serde(rename = "type")]
    pub message_type: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct SendMessageResponse {
    pub message_hash: String,
}
