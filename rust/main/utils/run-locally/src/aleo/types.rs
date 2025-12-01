use std::collections::BTreeMap;

use crate::{
    aleo::{cli::AleoCli, CHAIN_ID},
    utils::AgentHandles,
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
    pub mailbox_program: String,
    pub ism_manager_program: String,
    pub hook_manager_program: String,
    pub validator_announce_program: String,
    pub protocol: String,
    pub chain_id: u32,
    pub rpc_urls: Vec<AgentUrl>,
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
    pub(crate) native: String,
}

pub struct Deployment {
    pub(crate) cli: AleoCli,
    pub(crate) name: String,
    pub(crate) metrics: u32,
    pub(crate) domain: u32,
    pub(crate) contracts: Contracts,
    pub(crate) handle: AgentHandles,
}

#[derive(Debug, Clone)]
pub struct WarpContracts {
    pub native: TokenContract,
    pub synthetic: TokenContract,
}

#[derive(Debug, Clone)]
pub struct TokenContract {
    pub program: String,
    pub address: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct CoreContracts {
    pub mailbox: String,
    pub merkle_tree_hook: String,
    pub interchain_gas_paymaster: String,
    pub validator_announce: String,
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
            protocol: "aleo".to_owned(),
            chain_id: CHAIN_ID,
            rpc_urls: vec![AgentUrl {
                http: format!("{}/testnet", node.cli.endpoint),
            }],
            mailbox_program: "mailbox.aleo".to_owned(),
            ism_manager_program: "ism_manager.aleo".to_owned(),
            hook_manager_program: "hook_manager.aleo".to_owned(),
            validator_announce_program: "validator_announce.aleo".to_owned(),
        }
    }
}
