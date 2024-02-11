use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EmptyStruct {}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Log {
    pub msg_index: u64,
    pub events: Vec<Event>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Events {
    pub events: Vec<Event>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Event {
    #[serde(rename = "type")]
    pub typ: String,
    pub attributes: Vec<EventAttribute>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EventAttribute {
    pub key: String,
    pub value: String,
}

impl From<EventAttribute> for cosmrs::tendermint::abci::EventAttribute {
    fn from(val: EventAttribute) -> Self {
        cosmrs::tendermint::abci::EventAttribute {
            key: val.key,
            value: val.value,
            // WARN: This value isn't present in the `EventAttribute` result returned by the neutron RPC.
            // Seems irelevant so just setting it to `false`.
            index: false,
        }
    }
}
