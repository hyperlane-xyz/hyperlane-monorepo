use async_trait::async_trait;
use hyperlane_base::clients::ClientConf;
use std::error::Error;

pub struct SendCmd {
    pub address_destination: String,
    pub chain_destination: i32,
    pub bytes: String,
    pub client_conf: ClientConf,
}

pub struct QueryCmd {
    pub matching_list_file: Option<String>,
    pub block_depth: Option<u32>,
    pub print_output_type: String,
    pub client_conf: ClientConf,
}

#[async_trait]
pub trait ExecuteCliCmd {
    async fn execute(&self) -> Result<(), Box<dyn Error>>;
}

pub mod query;
pub mod send;
pub mod transaction;
