use serde::{Deserialize, Serialize};

use super::general::EmptyStruct;

const TREE_DEPTH: usize = 32;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MerkleTreeGenericRequest<T> {
    pub merkle_hook: T,
}

// --------- Requests ---------

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MerkleTreeRequest {
    pub tree: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MerkleTreeCountRequest {
    pub count: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CheckPointRequest {
    pub check_point: EmptyStruct,
}

// --------- Responses ---------

#[derive(Serialize, Deserialize, Debug)]
pub struct MerkleTreeResponse {
    pub branch: [String; TREE_DEPTH],
    pub count: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MerkleTreeCountResponse {
    pub count: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CheckPointResponse {
    pub root: String,
    pub count: u32,
}
