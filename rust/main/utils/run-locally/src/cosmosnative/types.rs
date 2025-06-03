use std::collections::BTreeMap;

use hyperlane_core::NativeToken;
use hyperlane_cosmos::RawCosmosAmount;

use crate::utils::AgentHandles;

use super::{
    cli::SimApp,
    constants::{CHAIN_ID, DENOM, PREFIX},
};

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
    pub index: AgentConfigIndex,
    pub gas_price: RawCosmosAmount,
    pub contract_address_bytes: usize,
    pub native_token: NativeToken,
    pub canonical_asset: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentConfigOut {
    pub chains: BTreeMap<String, AgentConfig>,
}

#[derive(Debug)]
pub struct Contracts {
    pub(crate) mailbox: String,
    pub(crate) igp: String,
    pub(crate) merkle_tree_hook: String,
    pub(crate) tokens: Vec<String>,
}

pub struct Deployment {
    pub(crate) chain: SimApp,
    pub(crate) name: String,
    pub(crate) metrics: u32,
    pub(crate) domain: u32,
    pub(crate) contracts: Contracts,
    pub(crate) handle: AgentHandles,
}

impl AgentConfig {
    pub fn new(node: &Deployment) -> Self {
        AgentConfig {
            name: node.name.clone(),
            domain_id: node.domain,
            metrics_port: node.metrics,
            mailbox: node.contracts.mailbox.clone(),
            interchain_gas_paymaster: node.contracts.igp.clone(),
            validator_announce: node.contracts.mailbox.clone(), // there is no dedicated validator_announce in cosmos, the mailbox includes that logic
            merkle_tree_hook: node.contracts.merkle_tree_hook.clone(),
            protocol: "cosmosnative".to_owned(),
            chain_id: CHAIN_ID.to_owned(),
            rpc_urls: vec![AgentUrl {
                http: format!("http://{}", node.chain.rpc_addr.replace("tcp://", "")),
            }],
            grpc_urls: vec![AgentUrl {
                http: format!("http://{}", node.chain.grpc_addr.replace("tcp://", "")),
            }],
            bech32_prefix: PREFIX.to_string(),
            gas_price: RawCosmosAmount {
                denom: DENOM.to_string(),
                amount: "0.2".to_string(),
            },
            contract_address_bytes: 20,
            index: AgentConfigIndex { from: 1, chunk: 5 },
            native_token: NativeToken {
                decimals: 6,
                denom: DENOM.to_string(),
            },
            canonical_asset: DENOM.to_owned(),
        }
    }
}
