use std::{collections::BTreeMap, path::PathBuf};

use hyperlane_cosmwasm_interface::types::bech32_decode;

use hyperlane_core::NativeToken;
use hyperlane_cosmos::RawCosmosAmount;

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

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Codes {
    pub hpl_hook_merkle: u64,
    pub hpl_hook_routing: u64,
    pub hpl_igp: u64,
    pub hpl_igp_oracle: u64,
    pub hpl_ism_aggregate: u64,
    pub hpl_ism_multisig: u64,
    pub hpl_ism_pausable: u64,
    pub hpl_ism_routing: u64,
    pub hpl_test_mock_ism: u64,
    pub hpl_test_mock_hook: u64,
    pub hpl_test_mock_msg_receiver: u64,
    pub hpl_mailbox: u64,
    pub hpl_validator_announce: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Deployments {
    pub hook_merkle: String,
    pub hook_routing: String,
    pub igp: String,
    pub igp_oracle: String,
    pub ism_aggregate: String,
    pub ism_routing: String,
    pub ism_multisig: String,
    pub mailbox: String,
    pub mock_receiver: String,
    pub mock_hook: String,
    pub mock_ism: String,
    pub va: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct BalanceResponse {
    pub balances: Vec<RawCosmosAmount>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct CliWasmQueryResponse<T> {
    pub data: T,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigAddrs {
    pub mailbox: String,
    pub interchain_gas_paymaster: String,
    pub validator_announce: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentConfigSigner {
    #[serde(rename = "type")]
    pub typ: String,
    pub key: String,
    pub prefix: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentConfigIndex {
    pub from: u32,
    pub chunk: u32,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentUrl {
    pub http: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub name: String,
    pub domain_id: u32,
    pub metrics_port: u32,
    pub mailbox: String,
    pub interchain_gas_paymaster: String,
    pub validator_announce: String,
    pub merkle_tree_hook: String,
    pub protocol: String,
    pub chain_id: String,
    pub rpc_urls: Vec<AgentUrl>,
    pub grpc_urls: Vec<AgentUrl>,
    pub bech32_prefix: String,
    pub signer: AgentConfigSigner,
    pub index: AgentConfigIndex,
    pub gas_price: RawCosmosAmount,
    pub contract_address_bytes: usize,
    pub native_token: NativeToken,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
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
            name: format!("cosmostest{}", network.domain),
            domain_id: network.domain,
            metrics_port: network.metrics_port,
            mailbox: to_hex_addr(&network.deployments.mailbox),
            interchain_gas_paymaster: to_hex_addr(&network.deployments.igp),
            validator_announce: to_hex_addr(&network.deployments.va),
            merkle_tree_hook: to_hex_addr(&network.deployments.hook_merkle),
            protocol: "cosmos".to_string(),
            chain_id: format!("cosmos-test-{}", network.domain),
            rpc_urls: vec![AgentUrl {
                http: format!(
                    "http://{}",
                    network.launch_resp.endpoint.rpc_addr.replace("tcp://", "")
                ),
            }],
            grpc_urls: vec![
                // The first url points to a nonexistent node, but is used for checking fallback provider logic
                AgentUrl {
                    http: "localhost:1337".to_string(),
                },
                AgentUrl {
                    http: format!("http://{}", network.launch_resp.endpoint.grpc_addr),
                },
            ],
            bech32_prefix: "osmo".to_string(),
            signer: AgentConfigSigner {
                typ: "cosmosKey".to_string(),
                key: format!("0x{}", hex::encode(validator.priv_key.to_bytes())),
                prefix: "osmo".to_string(),
            },
            gas_price: RawCosmosAmount {
                denom: "uosmo".to_string(),
                amount: "0.05".to_string(),
            },
            contract_address_bytes: 32,
            index: AgentConfigIndex { from: 1, chunk: 5 },
            native_token: NativeToken {
                decimals: 6,
                denom: "uosmo".to_string(),
            },
        }
    }
}
