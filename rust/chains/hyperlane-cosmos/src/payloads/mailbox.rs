use serde::{Deserialize, Serialize};

use super::general::EmptyStruct;

// Requests
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GeneralMailboxQuery<T> {
    pub mailbox: T,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CountRequest {
    pub count: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NonceRequest {
    pub nonce: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RecipientIsmRequest {
    pub recipient_ism: RecipientIsmRequestInner,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RecipientIsmRequestInner {
    pub recipient_addr: String, // hexbinary
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DefaultIsmRequest {
    pub default_ism: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DeliveredRequest {
    pub message_delivered: DeliveredRequestInner,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DeliveredRequestInner {
    pub id: String, // hexbinary
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProcessMessageRequest {
    pub process: ProcessMessageRequestInner,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProcessMessageRequestInner {
    pub metadata: String,
    pub message: String,
}

// Responses
#[derive(Serialize, Deserialize, Debug)]
pub struct CountResponse {
    pub count: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct NonceResponse {
    pub nonce: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DefaultIsmResponse {
    pub default_ism: String, // hexbineary
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DeliveredResponse {
    pub delivered: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecipientIsmResponse {
    pub ism: String,
}
