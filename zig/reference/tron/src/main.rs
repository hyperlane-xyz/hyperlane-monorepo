//! Real tron-rs/prost encodings and production wallet HTTP serde types.
#[path = "../../../../rust/main/chains/hyperlane-tron/src/provider/types.rs"]
mod http_types;
use k256::ecdsa::SigningKey;
use prost::Message;
use serde_json::json;
use sha2::{Digest, Sha256};
use tron_rs::tron::protocol::{self, transaction};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn chunks(text: &str) -> Vec<String> {
    text.chars()
        .collect::<Vec<_>>()
        .chunks(32)
        .map(|part| part.iter().collect())
        .collect()
}
fn bytes(value: &[u8]) -> Vec<String> {
    chunks(&hex(value))
}
fn main() -> Result<()> {
    let owner_hex = "4119e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
    let owner: Vec<u8> = (0..owner_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&owner_hex[i..i + 2], 16))
        .collect::<std::result::Result<_, _>>()?;
    let mut contract = vec![0x41];
    contract.extend([0x22; 20]);
    let key = SigningKey::from_bytes((&[0x11; 32]).into())?;
    let mut cases = vec![];
    for n in [0i64, 1, 127, 128, 65535, 65536, i64::MAX] {
        cases.push((format!("scalar_{n}"), n, 0usize, n, n, n));
    }
    for length in [0, 1, 55, 56, 127, 128, 255, 256, 4096] {
        cases.push((
            format!("data_{length}"),
            0x123456,
            length,
            1700000000000,
            1700000060000,
            100000000,
        ));
    }
    let mut parities = std::collections::BTreeSet::new();
    for (name, number, length, timestamp, expiration, fee_limit) in cases {
        for agent in [false, true] {
            let timestamp = if agent {
                timestamp.min(i64::MAX - 60_000)
            } else {
                timestamp
            };
            let expiration = if agent {
                timestamp + 60_000
            } else {
                expiration
            };
            let data: Vec<u8> = (0..length).map(|i| i as u8).collect();
            let block_id: [u8; 32] = std::array::from_fn(|i| (i * 7 + 3) as u8);
            let trigger = protocol::TriggerSmartContract {
                owner_address: owner.clone(),
                contract_address: contract.clone(),
                data: data.clone(),
                call_value: if length == 0 { number } else { 0 },
                call_token_value: if !agent && length == 0 { number } else { 0 },
                token_id: if !agent && length == 0 { number } else { 0 },
            };
            let trigger_bytes = trigger.encode_to_vec();
            let raw = transaction::Raw {
                ref_block_bytes: ((number & 0xffff) as u16).to_be_bytes().to_vec(),
                ref_block_num: number,
                ref_block_hash: block_id[8..16].to_vec(),
                expiration,
                auths: vec![],
                data: vec![],
                contract: vec![transaction::Contract {
                    r#type: 31,
                    parameter: Some(tron_rs::prost_types::Any::from_msg(&trigger)?),
                    provider: vec![],
                    contract_name: vec![],
                    permission_id: 0,
                }],
                scripts: vec![],
                timestamp,
                fee_limit,
            };
            let raw_bytes = raw.encode_to_vec();
            let id = Sha256::digest(&raw_bytes);
            let (signature, recovery) = key.sign_prehash_recoverable(&id)?;
            if recovery.to_byte() > 1 {
                return Err("unrepresentable recovery ID".into());
            }
            let mut sig = signature.to_bytes().to_vec();
            sig.push(recovery.to_byte() + 27);
            parities.insert(sig[64]);
            let signed = protocol::Transaction {
                raw_data: Some(raw),
                signature: vec![sig.clone()],
                ret: vec![],
            }
            .encode_to_vec();
            println!(
                "{}",
                json!({"kind":if agent {"transaction_agent"} else {"transaction"},"name":name,"input":{"ref_block_number":number.to_string(),"block_id":bytes(&block_id),"timestamp_ms":timestamp.to_string(),"expiration_ms":expiration.to_string(),"fee_limit":fee_limit.to_string(),"trigger":{"owner":bytes(&owner),"contract":bytes(&contract),"data":bytes(&data),"call_value":trigger.call_value.to_string(),"call_token_value":trigger.call_token_value.to_string(),"token_id":trigger.token_id.to_string()}},"expected":{"trigger":bytes(&trigger_bytes),"raw":bytes(&raw_bytes),"signed":bytes(&signed),"id":bytes(&id),"signature":bytes(&sig)}})
            );
        }
    }
    assert_eq!(parities, std::collections::BTreeSet::from([27, 28]));
    let block = json!({"blockID":hex(&[0x33;32]),"block_header":{"raw_data":{"number":123456,"timestamp":1700000000000i64}}});
    let value: http_types::BlockResponse = serde_json::from_value(block.clone())?;
    println!(
        "{}",
        json!({"kind":"BlockResponse","wire_utf8_chunks":chunks(&serde_json::to_string(&block)?),"expected":{"block_id":value.block_id.chars().collect::<Vec<_>>().chunks(32).map(|v|v.iter().collect::<String>()).collect::<Vec<_>>(),"number":value.block_header.raw_data.number,"timestamp":value.block_header.raw_data.timestamp}})
    );
    for raw in [
        json!({}),
        json!({"energy_required":1234}),
        json!({"energy_required":0,"result":{"code":"CONTRACT_EXE_ERROR","message":"726576657274"}}),
    ] {
        let value: http_types::EstimateEnergyResponse = serde_json::from_value(raw.clone())?;
        println!(
            "{}",
            json!({"kind":"EstimateEnergyResponse","wire_utf8_chunks":chunks(&serde_json::to_string(&raw)?),"expected":{"energy_required":value.energy_required,"has_result":value.result.is_some()}})
        );
    }
    for raw in [
        json!({}),
        json!({"constant_result":["","010203"]}),
        json!({"result":{"code":"CONTRACT_VALIDATE_ERROR","message":"726576657274"}}),
    ] {
        let value: http_types::TriggerConstantResponse = serde_json::from_value(raw.clone())?;
        println!(
            "{}",
            json!({"kind":"TriggerConstantResponse","wire_utf8_chunks":chunks(&serde_json::to_string(&raw)?),"expected":{"constant_result":value.constant_result,"has_result":value.result.is_some()}})
        );
    }
    for raw in [
        json!({"result":true}),
        json!({"result":false,"code":"SIGERROR","message":"626164"}),
        json!({}),
    ] {
        let value: http_types::BroadcastResponse = serde_json::from_value(raw.clone())?;
        println!(
            "{}",
            json!({"kind":"BroadcastResponse","wire_utf8_chunks":chunks(&serde_json::to_string(&raw)?),"expected":{"result":value.result,"code":value.code,"message":value.message}})
        );
    }
    let request = http_types::TriggerContractRequest {
        owner_address: hex(&owner),
        contract_address: hex(&contract),
        data: "010203".into(),
        call_value: 42,
        visible: false,
    };
    println!(
        "{}",
        json!({"kind":"TriggerContractRequest","wire_utf8_chunks":chunks(&serde_json::to_string(&request)?)})
    );
    Ok(())
}
