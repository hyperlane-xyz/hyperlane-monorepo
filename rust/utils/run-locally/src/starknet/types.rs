use std::{collections::BTreeMap, path::PathBuf};

use super::{cli::StarknetCLI, StarknetNetwork};

#[derive(Clone)]
pub struct StarknetEndpoint {
    pub rpc_addr: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DeclaredClasses {
    pub hpl_hook_merkle: String,
    pub hpl_hook_routing: String,
    pub hpl_igp: String,
    pub hpl_igp_oracle: String,
    pub hpl_ism_aggregate: String,
    pub hpl_ism_multisig: String,
    pub hpl_ism_pausable: String,
    pub hpl_ism_routing: String,
    pub hpl_test_mock_ism: String,
    pub hpl_test_mock_hook: String,
    pub hpl_test_mock_msg_receiver: String,
    pub hpl_mailbox: String,
    pub hpl_validator_announce: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
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

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DeclareResponse {
    pub class_hash: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentConfigSigner {
    #[serde(rename = "type")]
    pub typ: String,
    pub key: String,
    pub address: String,
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
    pub signer: AgentConfigSigner,
    pub index: AgentConfigIndex,
    pub contract_address_bytes: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentConfigOut {
    pub chains: BTreeMap<String, AgentConfig>,
}

impl AgentConfig {
    pub fn new(bin: PathBuf, _validator: &str, network: &StarknetNetwork) -> Self {
        let _cli = StarknetCLI::new(bin);

        AgentConfig {
            name: format!("starknettest{}", network.domain),
            domain_id: network.domain,
            metrics_port: network.metrics_port,
            mailbox: network.deployments.mailbox.clone(),
            interchain_gas_paymaster: network.deployments.igp.clone(),
            validator_announce: network.deployments.va.clone(),
            merkle_tree_hook: network.deployments.hook_merkle.clone(),
            protocol: "starknet".to_string(),
            chain_id: format!("starknet-test-{}", network.domain),
            rpc_urls: vec![AgentUrl {
                http: format!("{}", network.launch_resp.endpoint.rpc_addr),
            }],
            signer: AgentConfigSigner {
                typ: "starkKey".to_string(),
                key: "0x14d6672dcb4b77ca36a887e9a11cd9d637d5012468175829e9c6e770c61642".to_string(), // KATANA funded account num.2
                address: "0xe29882a1fcba1e7e10cad46212257fea5c752a4f9b1b1ec683c503a2cf5c8a"
                    .to_string(),
            },
            contract_address_bytes: 32,
            index: AgentConfigIndex {
                from: 1,
                chunk: 100,
            },
        }
    }
}
