use std::{collections::BTreeMap, path::PathBuf};

use super::{cli::StarknetCLI, StarknetNetwork};

#[derive(Clone)]
pub struct StarknetEndpoint {
    pub rpc_addr: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
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

#[derive(Clone, Debug)]
pub struct ValidatorConfig {
    pub private_key: String,
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
pub struct NativeTokenConfig {
    pub denom: String,
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
    pub rpc_urls: Vec<AgentUrl>,
    pub signer: AgentConfigSigner,
    pub index: AgentConfigIndex,
    pub contract_address_bytes: usize,
    pub native_token: NativeTokenConfig,
    pub max_batch_size: u32,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentConfigOut {
    pub chains: BTreeMap<String, AgentConfig>,
}

impl AgentConfig {
    pub fn new(bin: PathBuf, validator: &ValidatorConfig, network: &StarknetNetwork) -> Self {
        let _cli = StarknetCLI::new(bin);

        AgentConfig {
            name: format!("starknettest{}", network.domain),
            domain_id: network.domain,
            metrics_port: network.metrics_port,
            mailbox: network.deployments.mailbox.clone(),
            max_batch_size: 10,
            interchain_gas_paymaster: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84".to_string(),
            validator_announce: network.deployments.va.clone(),
            merkle_tree_hook: network.deployments.hook_merkle.clone(),
            native_token: NativeTokenConfig {
                denom: "0x04718F5A0FC34CC1AF16A1CDEE98FFB20C31F5CD61D6AB07201858F4287C938D"
                    .to_string(),
            }, // We use STARK as the native token for the E2E tests
            protocol: "starknet".to_string(),
            rpc_urls: vec![
                AgentUrl {
                    http: "http://127.0.0.1:1337".to_owned(), // invalid url to test fallback provider
                },
                AgentUrl {
                    http: "http://127.0.0.1:1338".to_owned(), // invalid url to test fallback provider
                },
                AgentUrl {
                    http: network.launch_resp.endpoint.rpc_addr.to_owned(),
                },
                AgentUrl {
                    http: "http://127.0.0.1:1347".to_owned(), // invalid url to test fallback provider
                },
            ],
            signer: AgentConfigSigner {
                typ: "starkKey".to_string(),
                key: validator.private_key.clone(),
                address: validator.address.clone(),
            },
            contract_address_bytes: 32,
            index: AgentConfigIndex {
                from: 1,
                chunk: 100,
            },
        }
    }
}
