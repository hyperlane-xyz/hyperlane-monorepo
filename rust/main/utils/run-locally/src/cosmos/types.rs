use hyperlane_cosmos::RawCosmosAmount;

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
