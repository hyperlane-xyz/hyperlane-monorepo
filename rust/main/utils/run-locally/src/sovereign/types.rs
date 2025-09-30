use hyperlane_sovereign::{ConnectionConf, Signer, SovereignClient};

use super::node::SovereignParameters;
use std::collections::BTreeMap;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentUrl {
    pub http: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigSigner {
    #[serde(rename = "type")]
    pub typ: String,
    pub key: String,
    pub account_type: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChainConfig {
    pub name: String,
    pub domain_id: u32,
    pub mailbox: String,
    pub interchain_gas_paymaster: String,
    pub validator_announce: String,
    pub merkle_tree_hook: String,
    pub protocol: String,
    pub rpc_urls: Vec<AgentUrl>,
    pub signer: AgentConfigSigner,
}

const SOVEREIGN_PROTOCOL: &str = "sovereign";
const NULL_CONTRACT_ADDRESS: &str = "0x0000000000000000000000000000000000000000";

impl ChainConfig {
    pub fn new(key: &str, params: &SovereignParameters) -> Self {
        Self {
            name: params.chain_name(),
            domain_id: params.id,
            protocol: SOVEREIGN_PROTOCOL.to_owned(),
            mailbox: NULL_CONTRACT_ADDRESS.to_owned(),
            interchain_gas_paymaster: NULL_CONTRACT_ADDRESS.to_owned(),
            validator_announce: NULL_CONTRACT_ADDRESS.to_owned(),
            merkle_tree_hook: NULL_CONTRACT_ADDRESS.to_owned(),
            rpc_urls: vec![AgentUrl {
                http: format!("http://127.0.0.1:{}", params.port),
            }],
            signer: AgentConfigSigner {
                typ: "sovereignKey".to_string(),
                key: key.to_owned(),
                account_type: "ethereum".to_string(),
            },
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ChainRegistry {
    pub chains: BTreeMap<String, ChainConfig>,
}

impl ChainRegistry {
    // returns all chains as a comma separated list
    pub fn as_relay_list(&self) -> String {
        self.chains.keys().cloned().collect::<Vec<_>>().join(",")
    }
}

pub async fn get_or_create_client(conf: &ChainConfig) -> SovereignClient {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CLIENT_CACHE: OnceLock<Mutex<HashMap<String, SovereignClient>>> = OnceLock::new();

    let cache = CLIENT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = conf.name.clone();

    {
        let map = cache.lock().unwrap();
        if let Some(client) = map.get(&key) {
            return client.clone();
        }
    }

    let client_key = conf
        .signer
        .key
        .parse()
        .expect("failed to parse private key");
    let signer =
        Signer::new(&client_key, &conf.signer.account_type, None).expect("failed to create signer");
    let connection_conf = ConnectionConf {
        url: conf.rpc_urls[0].http.parse().unwrap(),
        op_submission_config: Default::default(),
    };
    let client = SovereignClient::new(&connection_conf, signer)
        .await
        .expect("failed to create client");

    {
        let mut map = cache.lock().unwrap();
        map.insert(key, client.clone());
    }

    client
}
