#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct TxEventAttr {
    pub key: String,
    pub value: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct TxEvent {
    #[serde(rename = "type")]
    pub typ: String,
    pub attributes: Vec<TxEventAttr>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct TxLog {
    pub msg_index: u32,
    pub log: String,
    pub events: Vec<TxEvent>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct TxResponse {
    pub height: String,
    pub txhash: String,
    pub codespace: String,
    pub code: u32,
    pub data: String,
    pub raw_log: String,
    pub logs: Vec<TxLog>,
}
