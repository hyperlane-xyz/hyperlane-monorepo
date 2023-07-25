use serde::{Deserialize, Serialize};

use super::general::EmptyStruct;

const TREE_DEPTH: usize = 32;
// Requests

#[derive(Serialize, Deserialize, Debug)]
pub struct CountRequest {
    pub count: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DefaultIsmRequest {
    pub default_ism: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DeliveredRequest {
    pub message_delivered: DeliveredRequestInner,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DeliveredRequestInner {
    pub id: String, // hexbinary
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MerkleTreeRequest {
    pub merkle_tree: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ProcessMessageRequest {
    pub process_message: ProcessMessageRequestInner,
}

#[derive(Serialize, Deserialize, Debug)]
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
pub struct DefaultIsmResponse {
    pub default_ism: String, // hexbineary
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DeliveredResponse {
    pub delivered: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MerkleTreeResponse {
    pub branch: [String; TREE_DEPTH],
    pub count: u32,
}
