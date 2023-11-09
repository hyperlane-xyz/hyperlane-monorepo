use hyperlane_core::{HyperlaneMessage, H256};
use serde::{Deserialize, Serialize};

use crate::address::CosmosAddress;

use super::general::EmptyStruct;

// Requests
#[derive(Serialize, Deserialize, Debug)]
pub struct GeneralMailboxQuery<T> {
    pub mailbox: T,
}

impl<T> GeneralMailboxQuery<T> {
    pub fn new(inner: T) -> Self {
        Self { mailbox: inner }
    }
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct NonceRequest {
    pub nonce: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecipientIsmRequest {
    recipient_ism: RecipientIsmRequestInner,
}

impl RecipientIsmRequest {
    pub fn new(recipient_addr: CosmosAddress) -> Self {
        Self {
            recipient_ism: RecipientIsmRequestInner {
                recipient_addr: recipient_addr.address(),
            },
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct RecipientIsmRequestInner {
    recipient_addr: String,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct DefaultIsmRequest {
    pub default_ism: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DeliveredRequest {
    message_delivered: DeliveredRequestInner,
}

impl DeliveredRequest {
    pub fn new(id: H256) -> Self {
        Self {
            message_delivered: DeliveredRequestInner { id },
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct DeliveredRequestInner {
    // Trevor: note this will add a 0x prefix!
    id: H256,
}

#[derive(Serialize, Debug)]
pub struct ProcessMessageRequest<'a> {
    process: ProcessMessageRequestInner<'a>,
}

impl<'a> ProcessMessageRequest<'a> {
    pub fn new(message: &'a HyperlaneMessage, metadata: &'a [u8]) -> Self {
        Self {
            process: ProcessMessageRequestInner { message, metadata },
        }
    }
}

#[derive(Serialize, Debug)]
pub struct ProcessMessageRequestInner<'a> {
    #[serde(with = "hex::serde")]
    pub metadata: &'a [u8],
    #[serde(with = "crate::serde::serde_hex_encoded_hyperlane_message")]
    pub message: &'a HyperlaneMessage,
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
