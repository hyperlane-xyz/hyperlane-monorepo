use std::collections::BTreeMap;

use hyperlane_core::NativeToken;

use radix_common::prelude::ResourceAddress;
use scrypto::types::ComponentAddress;

use crate::radix::{cli::RadixCli, CHAIN_ID, CORE_API, GATEWAY_API, NETWORK};

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
    pub chain_id: u32,
    pub rpc_urls: Vec<AgentUrl>,
    pub gateway_urls: Vec<AgentUrl>,
    pub native_token: NativeToken,
    pub network_name: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentConfigOut {
    pub chains: BTreeMap<String, AgentConfig>,
}

#[derive(Debug)]
pub struct Contracts {
    pub(crate) mailbox: String,
    pub(crate) merkle_tree_hook: String,
    pub(crate) igp: String,
    pub(crate) validator_announce: String,
    pub(crate) collateral: ComponentAddress,
}

pub struct Deployment {
    pub(crate) cli: RadixCli,
    pub(crate) name: String,
    pub(crate) metrics: u32,
    pub(crate) domain: u32,
    pub(crate) contracts: Contracts,
    // pub(crate) handle: AgentHandles,
}

#[derive(Debug, Clone)]
pub struct ComponentCreationResult {
    pub address: ComponentAddress,
    pub badge: Option<ResourceAddress>,
}

#[derive(Debug, Clone)]
pub struct WarpContracts {
    pub collateral: TokenContract,
    pub synthetic: TokenContract,
}

#[derive(Debug, Clone)]
pub struct TokenContract {
    pub address: ComponentAddress,
    pub owner: ResourceAddress,
}

#[derive(Debug, Clone)]
pub struct CoreContracts {
    pub mailbox: ComponentAddress,
    pub merkle_tree_hook: ComponentAddress,
    pub interchain_gas_paymaster: ComponentAddress,
    pub validator_announce: ComponentAddress,
}

impl AgentConfig {
    pub fn new(node: &Deployment) -> Self {
        AgentConfig {
            name: node.name.clone(),
            domain_id: node.domain,
            metrics_port: node.metrics,
            mailbox: node.contracts.mailbox.clone(),
            interchain_gas_paymaster: node.contracts.igp.clone(),
            validator_announce: node.contracts.validator_announce.clone(),
            merkle_tree_hook: node.contracts.merkle_tree_hook.clone(),
            protocol: "radix".to_owned(),
            chain_id: CHAIN_ID,
            rpc_urls: vec![AgentUrl {
                http: CORE_API.to_owned(),
            }],
            gateway_urls: vec![AgentUrl {
                http: GATEWAY_API.to_owned(),
            }],
            native_token: NativeToken {
                decimals: 18,
                denom: "XRD".to_owned(),
            },
            network_name: NETWORK.logical_name.to_string(),
        }
    }
}
