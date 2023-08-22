use std::{collections::BTreeMap, path::PathBuf};

use hpl_interface::types::bech32_decode;

use super::{cli::OsmosisCLI, CosmosNetwork};

#[derive(serde::Serialize, serde::Deserialize)]
pub struct TxEventAttr {
    pub key: String,
    pub value: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct TxEvent {
    #[serde(rename = "type")]
    pub typ: String,
    pub attributes: Vec<TxEventAttr>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct TxLog {
    pub msg_index: u32,
    pub log: String,
    pub events: Vec<TxEvent>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct TxResponse {
    pub height: String,
    pub txhash: String,
    pub codespace: String,
    pub code: u32,
    pub data: String,
    pub raw_log: String,
    pub logs: Vec<TxLog>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Coin {
    pub denom: String,
    pub amount: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Codes {
    pub hpl_hub: u64,
    pub hpl_igp_core: u64,
    pub hpl_igp_gas_oracle: u64,
    pub hpl_ism_multisig: u64,
    pub hpl_ism_routing: u64,
    pub hpl_token_cw20: u64,
    pub hpl_token_native: u64,
    pub hpl_mailbox: u64,
    pub hpl_multicall: u64,
    pub hpl_validator_announce: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Deployments {
    pub igp: String,
    pub igp_oracle: String,
    pub ism_routing: String,
    pub ism_multisig: String,
    pub hub: String,
    pub mailbox: String,
    pub va: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct BalanceResponse {
    pub balances: Vec<Coin>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigAddrs {
    pub mailbox: String,
    pub interchain_gas_paymaster: String,
    pub validator_announce: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AgentConfigConn {
    pub rpc_url: String,
    pub grpc_url: String,
    pub chain_id: String,
    pub prefix: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AgentConfigSigner {
    #[serde(rename = "type")]
    pub typ: String,
    pub key: String,
    pub prefix: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AgentConfigIndex {
    pub from: u32,
    pub chunk: u32,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AgentConfig {
    pub name: String,
    pub domain: u32,
    pub addresses: AgentConfigAddrs,
    pub protocol: String,
    pub finality_blocks: u32,
    pub connection: AgentConfigConn,
    pub signer: AgentConfigSigner,
    pub index: AgentConfigIndex,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AgentConfigOut {
    pub chains: BTreeMap<String, AgentConfig>,
}

fn to_hex_addr(addr: &str) -> String {
    format!("0x{}", hex::encode(bech32_decode(addr).unwrap()))
}

impl AgentConfig {
    pub fn new(bin: PathBuf, validator: &str, network: &CosmosNetwork) -> Self {
        let cli = OsmosisCLI::new(bin, network.launch_resp.home_path.to_str().unwrap());
        let validator = cli.get_keypair(validator);

        AgentConfig {
            name: format!("cosmos-test-{}", network.domain),
            domain: network.domain,
            addresses: AgentConfigAddrs {
                mailbox: to_hex_addr(&network.deployments.mailbox),
                interchain_gas_paymaster: to_hex_addr(&network.deployments.igp),
                validator_announce: to_hex_addr(&network.deployments.va),
            },
            protocol: "cosmos".to_string(),
            finality_blocks: 1,
            connection: AgentConfigConn {
                rpc_url: network
                    .launch_resp
                    .endpoint
                    .rpc_addr
                    .to_string()
                    .replace("tcp", "http"),
                grpc_url: format!("http://{}", network.launch_resp.endpoint.grpc_addr),
                chain_id: network.chain_id.to_string(),
                prefix: "osmo".to_string(),
            },
            signer: AgentConfigSigner {
                typ: "cosmosKey".to_string(),
                key: hex::encode(validator.priv_key.to_bytes()),
                prefix: "osmo".to_string(),
            },
            index: AgentConfigIndex { from: 1, chunk: 10 },
        }
    }
}
