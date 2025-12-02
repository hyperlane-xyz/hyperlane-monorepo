use std::{collections::HashMap, fs::File, path::PathBuf};

use serde::{Deserialize, Serialize};
use solana_client::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RpcUrlConfig {
    pub http: String,
}

/// An abridged version of the Typescript ChainMetadata
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChainMetadata {
    /// Hyperlane domain, only required if differs from id above
    pub domain_id: u32,
    pub name: String,
    /// Collection of RPC endpoints
    pub rpc_urls: Vec<RpcUrlConfig>,
    pub is_testnet: Option<bool>,
}

impl ChainMetadata {
    pub fn client(&self) -> RpcClient {
        RpcClient::new_with_commitment(self.rpc_urls[0].http.clone(), CommitmentConfig::confirmed())
    }
}

pub struct FileSystemRegistry {
    path: PathBuf,
}

impl FileSystemRegistry {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn get_metadata(&self) -> HashMap<String, ChainMetadata> {
        let file_path = self.path.join("chains").join("metadata.yaml");
        let file = File::open(file_path).unwrap();
        let records: HashMap<String, ChainMetadata> = serde_yaml::from_reader(file).unwrap();
        records
    }
}
