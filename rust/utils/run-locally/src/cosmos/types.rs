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
    pub hpl_mailbox: u64,
    pub hpl_multicall: u64,
    pub hpl_validator_announce: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Deployments {
    pub igp: String,
    pub igp_oracle: String,
    pub hub: String,
    pub mailbox: String,
    pub va: String,
}
