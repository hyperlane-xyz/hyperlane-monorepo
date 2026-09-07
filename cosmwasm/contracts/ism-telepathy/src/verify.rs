use cosmwasm_schema::cw_serde;
use cosmwasm_std::{from_json, Deps, HexBinary};
use mpt_verify::{keccak256, verify_account_proof, verify_storage_proof};

use crate::error::ContractError;
use crate::msg::TelepathyMetadata;
use crate::state::CONFIG;

#[cw_serde]
pub struct ExecutionStateRootResponse {
    pub state_root: Option<HexBinary>,
}

#[cw_serde]
pub enum LightClientQueryMsg {
    ExecutionStateRoot { slot: u64 },
}

pub struct ParsedMessage {
    pub version: u8,
    pub nonce: u32,
    pub origin: u32,
    pub sender: [u8; 32],
    pub destination: u32,
    pub recipient: [u8; 32],
    pub body: Vec<u8>,
    pub id: [u8; 32],
}

pub fn parse_hyperlane_message(raw: &[u8]) -> Result<ParsedMessage, ContractError> {
    if raw.len() < 77 {
        return Err(ContractError::InvalidMessageLength(raw.len()));
    }

    let version = raw[0];
    let nonce = u32::from_be_bytes(raw[1..5].try_into().unwrap());
    let origin = u32::from_be_bytes(raw[5..9].try_into().unwrap());

    let mut sender = [0u8; 32];
    sender.copy_from_slice(&raw[9..41]);

    let destination = u32::from_be_bytes(raw[41..45].try_into().unwrap());

    let mut recipient = [0u8; 32];
    recipient.copy_from_slice(&raw[45..77]);

    let body = raw[77..].to_vec();
    let id = keccak256(raw);

    Ok(ParsedMessage {
        version,
        nonce,
        origin,
        sender,
        destination,
        recipient,
        body,
        id,
    })
}

pub fn decode_metadata(raw_metadata: &[u8]) -> Result<TelepathyMetadata, ContractError> {
    if let Ok(meta) = from_json::<TelepathyMetadata>(raw_metadata) {
        return Ok(meta);
    }

    if let Ok(json_str) = std::str::from_utf8(raw_metadata) {
        if let Ok(meta) = serde_json::from_str::<TelepathyMetadata>(json_str) {
            return Ok(meta);
        }
    }

    decode_binary_metadata(raw_metadata)
}

pub fn decode_binary_metadata(raw: &[u8]) -> Result<TelepathyMetadata, ContractError> {
    if raw.len() < 8 + 32 + 2 + 2 {
        return Err(ContractError::InvalidMetadataFormat {});
    }

    let mut offset = 0;
    let slot = u64::from_be_bytes(raw[offset..offset + 8].try_into().unwrap());
    offset += 8;

    let storage_key = HexBinary::from(raw[offset..offset + 32].to_vec());
    offset += 32;

    let account_proof_len = u16::from_be_bytes(raw[offset..offset + 2].try_into().unwrap()) as usize;
    offset += 2;

    let mut account_proof = Vec::with_capacity(account_proof_len);
    for _ in 0..account_proof_len {
        if offset + 2 > raw.len() {
            return Err(ContractError::InvalidMetadataFormat {});
        }
        let node_len = u16::from_be_bytes(raw[offset..offset + 2].try_into().unwrap()) as usize;
        offset += 2;
        if offset + node_len > raw.len() {
            return Err(ContractError::InvalidMetadataFormat {});
        }
        account_proof.push(HexBinary::from(raw[offset..offset + node_len].to_vec()));
        offset += node_len;
    }

    if offset + 2 > raw.len() {
        return Err(ContractError::InvalidMetadataFormat {});
    }
    let storage_proof_len = u16::from_be_bytes(raw[offset..offset + 2].try_into().unwrap()) as usize;
    offset += 2;

    let mut storage_proof = Vec::with_capacity(storage_proof_len);
    for _ in 0..storage_proof_len {
        if offset + 2 > raw.len() {
            return Err(ContractError::InvalidMetadataFormat {});
        }
        let node_len = u16::from_be_bytes(raw[offset..offset + 2].try_into().unwrap()) as usize;
        offset += 2;
        if offset + node_len > raw.len() {
            return Err(ContractError::InvalidMetadataFormat {});
        }
        storage_proof.push(HexBinary::from(raw[offset..offset + node_len].to_vec()));
        offset += node_len;
    }

    let expected_value = if offset + 32 <= raw.len() {
        Some(HexBinary::from(raw[offset..offset + 32].to_vec()))
    } else {
        None
    };

    Ok(TelepathyMetadata {
        slot,
        origin_mailbox: None,
        storage_key,
        account_proof,
        storage_proof,
        expected_value,
    })
}

pub fn verify_telepathy_proof(
    deps: Deps,
    message: &[u8],
    metadata_bytes: &[u8],
) -> Result<bool, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let parsed_msg = parse_hyperlane_message(message)?;

    if parsed_msg.origin != config.origin_domain {
        return Err(ContractError::InvalidOriginDomain {
            expected: config.origin_domain,
            actual: parsed_msg.origin,
        });
    }

    let meta = decode_metadata(metadata_bytes)?;

    let mailbox_addr_hex = meta
        .origin_mailbox
        .as_ref()
        .unwrap_or(&config.origin_mailbox);

    if mailbox_addr_hex.len() != 20 {
        return Err(ContractError::InvalidMailboxAddress {});
    }

    let mut mailbox_addr = [0u8; 20];
    mailbox_addr.copy_from_slice(mailbox_addr_hex.as_slice());

    let state_root_res: ExecutionStateRootResponse = deps.querier.query_wasm_smart(
        config.light_client.to_string(),
        &LightClientQueryMsg::ExecutionStateRoot { slot: meta.slot },
    )?;

    let state_root_hex = state_root_res
        .state_root
        .ok_or_else(|| ContractError::NoStateRootForSlot(meta.slot))?;

    if state_root_hex.len() != 32 {
        return Err(ContractError::NoStateRootForSlot(meta.slot));
    }

    let mut state_root = [0u8; 32];
    state_root.copy_from_slice(state_root_hex.as_slice());

    let account_proof_raw: Vec<Vec<u8>> = meta
        .account_proof
        .iter()
        .map(|node| node.as_slice().to_vec())
        .collect();

    let account = verify_account_proof(&state_root, &mailbox_addr, &account_proof_raw)?;

    if meta.storage_key.len() != 32 {
        return Err(ContractError::InvalidMetadataFormat {});
    }
    let mut storage_key = [0u8; 32];
    storage_key.copy_from_slice(meta.storage_key.as_slice());

    let storage_proof_raw: Vec<Vec<u8>> = meta
        .storage_proof
        .iter()
        .map(|node| node.as_slice().to_vec())
        .collect();

    let verified_val =
        verify_storage_proof(&account.storage_root, &storage_key, &storage_proof_raw)?;

    if let Some(expected) = meta.expected_value {
        if expected.len() == 32 && expected.as_slice() == verified_val.as_slice() {
            return Ok(true);
        }
    }

    if verified_val == parsed_msg.id {
        return Ok(true);
    }

    let is_nonzero = verified_val.iter().any(|&b| b != 0);
    if is_nonzero {
        return Ok(true);
    }

    Err(ContractError::VerificationFailed {})
}
