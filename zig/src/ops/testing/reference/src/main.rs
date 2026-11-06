#![allow(dead_code)]
use chrono::{DateTime, Utc};
use eyre::{bail, ensure, eyre, Context, Result};
use hyperlane_core::{
    matching_list::{ListElement, MatchInfo, MatchingList},
    utils::hex_or_base58_or_bech32_to_h256,
    H256,
};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::io::{self, BufRead};
const TRON_ADDRESS_PREFIX: u8 = 0x41;
include!(concat!(env!("OUT_DIR"), "/source.rs"));
#[derive(Deserialize)]
struct Input {
    text: String,
    now: i64,
    #[serde(default)]
    nanos: u32,
}
fn main() {
    for line in io::stdin().lock().lines() {
        let input: Input = serde_json::from_str(&line.unwrap()).unwrap();
        let now = DateTime::from_timestamp(input.now, input.nanos).unwrap();
        let result = match parse_rules(input.text.as_bytes(), now) {
            Ok(rules) => {
                serde_json::json!({"accepted":true,"messages":rules.messages.len(),"addresses":rules.addresses.len(),"fingerprint":rules.fingerprint})
            }
            Err(_) => serde_json::json!({"accepted":false}),
        };
        println!("{}", result);
    }
}
