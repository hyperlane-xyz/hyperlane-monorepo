use std::{collections::BTreeMap, fmt::Error, fs};

use hyperlane_ton::ConversionUtils;
use tonlib_core::TonAddress;

use crate::log;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentUrl {
    pub http: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentConfigSigner {
    #[serde(rename = "type")]
    pub typ: String,
    pub mnemonic_phrase: String,
    pub wallet_version: String,
}
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct RawTonAmount {
    pub denom: String,
    pub amount: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentConfigIndex {
    pub from: u32,
    pub chunk: u32,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct TonAgentConfigOut {
    pub chains: BTreeMap<String, TonAgentConfig>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TonAgentConfig {
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
    pub api_key: String,
    pub signer: AgentConfigSigner,
    pub gas_price: RawTonAmount,
    pub contract_address_bytes: usize,
    pub index: AgentConfigIndex,
}

impl TonAgentConfig {
    pub fn new(
        name: &str,
        domain_id: u32,
        rpc_url: &str,
        api_key: &str,
        signer_phrase: &str,
        wallet_version: &str,
        mailbox: &str,
        igp: &str,
        validator_announce: &str,
        merkle_tree_hook: &str,
    ) -> Self {
        log!("TonAgentConfig::new() mailbox:{:?} igp:{:?}, validator_announce:{:?} merkle_tree_hook:{:?}", mailbox, igp, validator_announce, merkle_tree_hook);
        let mnemonic_vec: Vec<String> = signer_phrase
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();

        TonAgentConfig {
            name: name.to_string(),
            domain_id,
            metrics_port: 9093,
            mailbox: prepare_address(mailbox),
            interchain_gas_paymaster: prepare_address(igp),
            validator_announce: prepare_address(validator_announce),
            merkle_tree_hook: prepare_address(merkle_tree_hook),
            protocol: "ton".to_string(),
            chain_id: format!("{}", domain_id),
            rpc_urls: vec![AgentUrl {
                http: rpc_url.to_string(),
            }],
            api_key: api_key.to_string(),
            signer: AgentConfigSigner {
                typ: "TonMnemonic".to_string(),
                mnemonic_phrase: mnemonic_vec.join(" "),
                wallet_version: wallet_version.to_string(),
            },

            gas_price: RawTonAmount {
                denom: "ton".to_string(),
                amount: "0.01".to_string(),
            },
            contract_address_bytes: 32,
            index: AgentConfigIndex {
                from: 1,
                chunk: 26942839,
            },
        }
    }
}

fn prepare_address(base64_addr: &str) -> String {
    format!(
        "0x{}",
        hex::encode(
            ConversionUtils::ton_address_to_h256(
                &TonAddress::from_base64_url(base64_addr).unwrap()
            )
            .as_bytes()
        )
    )
}

pub fn generate_ton_config(
    output_name: &str,
    mnemonic: &str,
    wallet_version: &str,
    api_key: &str,
    domains: (&str, &str),
) -> Result<Vec<TonAgentConfig>, Error> {
    let output_path = format!("../../config/{output_name}.json");

    let deployed_contracts_1 = read_deployed_contracts(domains.0);
    let deployed_contracts_2 = read_deployed_contracts(domains.1);

    let ton_chains = vec![
        create_chain_config(
            "tontest1",
            domains.0,
            &mnemonic,
            wallet_version,
            api_key,
            &deployed_contracts_1,
        ),
        create_chain_config(
            "tontest2",
            domains.1,
            &mnemonic,
            wallet_version,
            api_key,
            &deployed_contracts_2,
        ),
    ];
    let mut chains_map = BTreeMap::new();
    for chain in &ton_chains {
        chains_map.insert(chain.name.clone(), chain.clone());
    }
    let ton_config = TonAgentConfigOut { chains: chains_map };
    let json_output = serde_json::to_string_pretty(&ton_config).unwrap();

    fs::write(&output_path, json_output).unwrap();
    log!("TON configuration written to {}", output_path);

    Ok(ton_chains)
}

fn read_deployed_contracts(domain: &str) -> BTreeMap<String, String> {
    use serde_json::Value;
    use std::path::Path;

    let path = format!(
        "../../../../altvm_contracts/ton/deployedContracts_{}.json",
        domain
    );

    if Path::new(&path).exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<Value>(&content) {
                if let Some(map) = json.as_object() {
                    return map
                        .iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                        .collect();
                }
            }
        }
    }

    log!("No deployed contracts found for domain {}", domain);
    BTreeMap::new()
}
fn create_chain_config(
    name: &str,
    domain_str: &str,
    mnemonic: &str,
    wallet_version: &str,
    api_key: &str,
    contracts: &BTreeMap<String, String>,
) -> TonAgentConfig {
    use std::str::FromStr;
    let domain = u32::from_str(domain_str).expect("Invalid domain ID");

    TonAgentConfig::new(
        name,
        domain,
        "https://testnet.toncenter.com/api/",
        api_key,
        mnemonic,
        wallet_version,
        contracts.get("mailboxAddress").unwrap_or(&"".to_string()),
        contracts
            .get("interchainGasPaymasterAddress")
            .unwrap_or(&"".to_string()),
        contracts
            .get("validatorAnnounceAddress")
            .unwrap_or(&"".to_string()),
        contracts
            .get("merkleTreeHookAddress")
            .unwrap_or(&"".to_string()),
    )
}
