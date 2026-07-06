// rustc >= 1.90 no longer counts derive(Deserialize) as construction; these
// types mirror the CosmWasm API shape.
#![allow(dead_code)]

use cometbft::abci::v0_34;
use cometbft::abci::v0_37;
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
    pub index: bool,
}

impl From<EventAttribute> for cosmrs::tendermint::abci::EventAttribute {
    fn from(val: EventAttribute) -> Self {
        cosmrs::tendermint::abci::EventAttribute::from((val.key, val.value, val.index))
    }
}

impl From<EventAttribute> for cometbft::abci::EventAttribute {
    fn from(val: EventAttribute) -> Self {
        cometbft::abci::EventAttribute::from((val.key, val.value, val.index))
    }
}
