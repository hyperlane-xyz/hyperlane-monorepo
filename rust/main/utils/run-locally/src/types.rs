use std::collections::BTreeMap;

use hyperlane_core::NativeToken;
use hyperlane_cosmos::RawCosmosAmount;

use crate::utils::{stop_child, AgentHandles};

#[cfg(feature = "cosmos")]
use {
    crate::cosmos::{CosmosNetwork, OsmosisCLI},
    crate::utils::cw_to_hex_addr,
    std::path::PathBuf,
};

#[cfg(feature = "fuel")]
use {crate::fuel::FuelNetwork, crate::utils::fuel_to_hex_addr};

pub struct HyperlaneStack {
    pub validators: Vec<AgentHandles>,
    pub relayer: AgentHandles,
    pub scraper: AgentHandles,
    pub postgres: AgentHandles,
}

impl Drop for HyperlaneStack {
    fn drop(&mut self) {
        for v in &mut self.validators {
            stop_child(&mut v.1);
        }
        stop_child(&mut self.relayer.1);
        stop_child(&mut self.scraper.1);
        stop_child(&mut self.postgres.1);
    }
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

impl AgentConfig {
    #[cfg(feature = "cosmos")]
    pub fn cosmos(bin: PathBuf, validator: &str, network: &CosmosNetwork) -> Self {
        let cli = OsmosisCLI::new(bin, network.launch_resp.home_path.to_str().unwrap());
        let validator = cli.get_keypair(validator);

        AgentConfig {
            name: format!("cosmostest{}", network.domain),
            domain_id: network.domain,
            metrics_port: network.metrics_port,
            mailbox: cw_to_hex_addr(&network.deployments.mailbox),
            interchain_gas_paymaster: cw_to_hex_addr(&network.deployments.igp),
            validator_announce: cw_to_hex_addr(&network.deployments.va),
            merkle_tree_hook: cw_to_hex_addr(&network.deployments.hook_merkle),
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

    #[cfg(feature = "fuel")]
    pub fn fuel(network_index: u32, signer: &str, network: &FuelNetwork) -> Self {
        AgentConfig {
            name: network.name.clone(),
            domain_id: network.config.domain,
            metrics_port: network.config.metrics_port,
            mailbox: fuel_to_hex_addr(network.deployments.mailbox.contract_id()),
            interchain_gas_paymaster: fuel_to_hex_addr(
                network.deployments.gas_paymaster.contract_id(),
            ),
            validator_announce: fuel_to_hex_addr(
                network.deployments.validator_announce.contract_id(),
            ),
            merkle_tree_hook: fuel_to_hex_addr(network.deployments.merkle_tree_hook.contract_id()),
            protocol: "fuel".to_string(),
            chain_id: format!("fuel-test-{}", network_index),
            rpc_urls: vec![AgentUrl {
                http: format!(
                    "http://{}/v1/graphql",
                    network.config.node.bound_address().to_string()
                ),
            }],
            grpc_urls: vec![],
            bech32_prefix: "fuel".to_string(),
            signer: AgentConfigSigner {
                typ: "hexKey".to_string(),
                key: signer.to_string(),
                prefix: "0x".to_string(),
            },
            gas_price: RawCosmosAmount {
                denom: "ETH".to_string(),
                amount: "1".to_string(),
            },
            contract_address_bytes: 32,
            index: AgentConfigIndex { from: 1, chunk: 5 },
            native_token: NativeToken {
                decimals: 9,
                denom: "ETH".to_string(),
            },
        }
    }
}
