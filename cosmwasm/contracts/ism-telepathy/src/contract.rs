use cosmwasm_std::{
    to_json_binary, Binary, Deps, DepsMut, Env, HexBinary, MessageInfo, Response, StdResult,
};
use cw2::set_contract_version;

use crate::error::ContractError;
use crate::msg::{
    ConfigResponse, ExecuteMsg, IsmQuery, ModuleTypeResponse, OffchainVerifyInfoResponse,
    QueryMsg, UrlsResponse, VerifyResponse,
};
use crate::state::{Config, CONFIG};
use crate::verify::verify_telepathy_proof;

const CONTRACT_NAME: &str = "crates.io:ism-telepathy";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: crate::msg::InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let owner = msg
        .owner
        .map(|o| deps.api.addr_validate(&o))
        .transpose()?
        .unwrap_or(info.sender);

    let light_client = deps.api.addr_validate(&msg.light_client)?;

    if msg.origin_mailbox.len() != 20 {
        return Err(ContractError::InvalidMailboxAddress {});
    }

    if msg.urls.is_empty() {
        return Err(ContractError::EmptyUrls {});
    }

    let config = Config {
        owner,
        pending_owner: None,
        light_client,
        origin_mailbox: msg.origin_mailbox,
        origin_domain: msg.origin_domain,
        urls: msg.urls,
    };
    CONFIG.save(deps.storage, &config)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("owner", config.owner)
        .add_attribute("light_client", config.light_client)
        .add_attribute("origin_domain", config.origin_domain.to_string()))
}

pub fn execute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::SetUrls { urls } => execute_set_urls(deps, info, urls),
        ExecuteMsg::SetLightClient { light_client } => {
            execute_set_light_client(deps, info, light_client)
        }
        ExecuteMsg::SetOriginMailbox {
            origin_mailbox,
            origin_domain,
        } => execute_set_origin_mailbox(deps, info, origin_mailbox, origin_domain),
        ExecuteMsg::TransferOwnership { new_owner } => {
            execute_transfer_ownership(deps, info, new_owner)
        }
        ExecuteMsg::AcceptOwnership {} => execute_accept_ownership(deps, info),
        ExecuteMsg::VerifyAndExecute { message, metadata } => {
            execute_verify_and_execute(deps, info, message, metadata)
        }
    }
}

pub fn execute_set_urls(
    deps: DepsMut,
    info: MessageInfo,
    urls: Vec<String>,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.owner {
        return Err(ContractError::Unauthorized {});
    }
    if urls.is_empty() {
        return Err(ContractError::EmptyUrls {});
    }
    config.urls = urls;
    CONFIG.save(deps.storage, &config)?;

    Ok(Response::new().add_attribute("action", "set_urls"))
}

pub fn execute_set_light_client(
    deps: DepsMut,
    info: MessageInfo,
    light_client: String,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.owner {
        return Err(ContractError::Unauthorized {});
    }
    config.light_client = deps.api.addr_validate(&light_client)?;
    CONFIG.save(deps.storage, &config)?;

    Ok(Response::new()
        .add_attribute("action", "set_light_client")
        .add_attribute("light_client", config.light_client))
}

pub fn execute_set_origin_mailbox(
    deps: DepsMut,
    info: MessageInfo,
    origin_mailbox: HexBinary,
    origin_domain: u32,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.owner {
        return Err(ContractError::Unauthorized {});
    }
    if origin_mailbox.len() != 20 {
        return Err(ContractError::InvalidMailboxAddress {});
    }
    config.origin_mailbox = origin_mailbox;
    config.origin_domain = origin_domain;
    CONFIG.save(deps.storage, &config)?;

    Ok(Response::new()
        .add_attribute("action", "set_origin_mailbox")
        .add_attribute("origin_domain", origin_domain.to_string()))
}

pub fn execute_transfer_ownership(
    deps: DepsMut,
    info: MessageInfo,
    new_owner: String,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.owner {
        return Err(ContractError::Unauthorized {});
    }
    let pending_owner = deps.api.addr_validate(&new_owner)?;
    config.pending_owner = Some(pending_owner.clone());
    CONFIG.save(deps.storage, &config)?;

    Ok(Response::new()
        .add_attribute("action", "transfer_ownership")
        .add_attribute("pending_owner", pending_owner))
}

pub fn execute_accept_ownership(
    deps: DepsMut,
    info: MessageInfo,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    match &config.pending_owner {
        Some(pending) if *pending == info.sender => {
            config.owner = pending.clone();
            config.pending_owner = None;
            CONFIG.save(deps.storage, &config)?;
            Ok(Response::new()
                .add_attribute("action", "accept_ownership")
                .add_attribute("new_owner", config.owner))
        }
        _ => Err(ContractError::Unauthorized {}),
    }
}

pub fn execute_verify_and_execute(
    deps: DepsMut,
    _info: MessageInfo,
    message: HexBinary,
    metadata: HexBinary,
) -> Result<Response, ContractError> {
    let verified = verify_telepathy_proof(deps.as_ref(), message.as_slice(), metadata.as_slice())?;
    if !verified {
        return Err(ContractError::VerificationFailed {});
    }

    Ok(Response::new()
        .add_attribute("action", "verify_and_execute")
        .add_attribute("verified", "true"))
}

pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Ism(ism_query) => match ism_query {
            IsmQuery::ModuleType {} => to_json_binary(&ModuleTypeResponse {
                typ: "ccip_read".to_string(),
            }),
            IsmQuery::Verify { message, metadata } => {
                let verified = verify_telepathy_proof(deps, message.as_slice(), metadata.as_slice())
                    .unwrap_or(false);
                to_json_binary(&VerifyResponse { verified })
            }
            IsmQuery::VerifyInfo { message } => {
                let config = CONFIG.load(deps.storage)?;
                to_json_binary(&OffchainVerifyInfoResponse {
                    urls: config.urls,
                    call_data: message.clone(),
                    extra_data: message,
                })
            }
        },
        QueryMsg::ModuleType {} => to_json_binary(&ModuleTypeResponse {
            typ: "ccip_read".to_string(),
        }),
        QueryMsg::Verify { message, metadata } => {
            let verified = verify_telepathy_proof(deps, message.as_slice(), metadata.as_slice())
                .unwrap_or(false);
            to_json_binary(&VerifyResponse { verified })
        }
        QueryMsg::GetOffchainVerifyInfo { message } => {
            let config = CONFIG.load(deps.storage)?;
            to_json_binary(&OffchainVerifyInfoResponse {
                urls: config.urls,
                call_data: message.clone(),
                extra_data: message,
            })
        }
        QueryMsg::GetConfig {} => {
            let config = CONFIG.load(deps.storage)?;
            to_json_binary(&ConfigResponse {
                owner: config.owner,
                pending_owner: config.pending_owner,
                light_client: config.light_client,
                origin_mailbox: config.origin_mailbox,
                origin_domain: config.origin_domain,
                urls: config.urls,
            })
        }
        QueryMsg::GetUrls {} => {
            let config = CONFIG.load(deps.storage)?;
            to_json_binary(&UrlsResponse { urls: config.urls })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::{from_json, ContractResult, SystemResult, WasmQuery};
    use mpt_verify::{bytes_to_nibbles, encode_compact_path, keccak256};
    use rlp::RlpStream;
    use crate::msg::TelepathyMetadata;

    #[test]
    fn test_module_type_query() {
        let mut deps = mock_dependencies();
        let info = mock_info("owner", &[]);
        let msg = crate::msg::InstantiateMsg {
            owner: Some("owner".to_string()),
            light_client: "telepathy_light_client".to_string(),
            origin_mailbox: HexBinary::from(vec![0x11u8; 20]),
            origin_domain: 1,
            urls: vec!["https://telepathy.hyperlane.xyz".to_string()],
        };

        instantiate(deps.as_mut(), mock_env(), info, msg).unwrap();

        let res = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::Ism(IsmQuery::ModuleType {}),
        )
        .unwrap();
        let resp: ModuleTypeResponse = from_json(&res).unwrap();
        assert_eq!(resp.typ, "ccip_read");
    }

    #[test]
    fn test_admin_updates() {
        let mut deps = mock_dependencies();
        let info = mock_info("owner", &[]);
        let msg = crate::msg::InstantiateMsg {
            owner: Some("owner".to_string()),
            light_client: "telepathy_light_client".to_string(),
            origin_mailbox: HexBinary::from(vec![0x11u8; 20]),
            origin_domain: 1,
            urls: vec!["https://telepathy.hyperlane.xyz".to_string()],
        };
        instantiate(deps.as_mut(), mock_env(), info.clone(), msg).unwrap();

        let set_urls = ExecuteMsg::SetUrls {
            urls: vec!["https://backup-telepathy.hyperlane.xyz".to_string()],
        };
        execute(deps.as_mut(), mock_env(), info.clone(), set_urls).unwrap();

        let q_urls = query(deps.as_ref(), mock_env(), QueryMsg::GetUrls {}).unwrap();
        let urls_resp: UrlsResponse = from_json(&q_urls).unwrap();
        assert_eq!(urls_resp.urls[0], "https://backup-telepathy.hyperlane.xyz");

        let transfer = ExecuteMsg::TransferOwnership {
            new_owner: "new_owner".to_string(),
        };
        execute(deps.as_mut(), mock_env(), info, transfer).unwrap();

        let accept = ExecuteMsg::AcceptOwnership {};
        execute(deps.as_mut(), mock_env(), mock_info("new_owner", &[]), accept).unwrap();

        let q_cfg = query(deps.as_ref(), mock_env(), QueryMsg::GetConfig {}).unwrap();
        let cfg_resp: ConfigResponse = from_json(&q_cfg).unwrap();
        assert_eq!(cfg_resp.owner, "new_owner");
    }

    #[test]
    fn test_end_to_end_verification() {
        let mut deps = mock_dependencies();

        let origin_mailbox = [0x33u8; 20];
        let slot = 42u64;

        let storage_key = [0x77u8; 32];
        let storage_val = [0x88u8; 32];

        let mut val_stream = RlpStream::new();
        val_stream.append(&storage_val.as_slice());
        let storage_val_rlp = val_stream.out().to_vec();

        let storage_hashed_key = keccak256(&storage_key);
        let storage_nibbles = bytes_to_nibbles(&storage_hashed_key);
        let encoded_storage_path = encode_compact_path(&storage_nibbles, true);

        let mut storage_node_stream = RlpStream::new_list(2);
        storage_node_stream.append(&encoded_storage_path);
        storage_node_stream.append(&storage_val_rlp);
        let storage_node = storage_node_stream.out().to_vec();
        let storage_root = keccak256(&storage_node);

        let code_hash = [0x99u8; 32];
        let mut account_stream = RlpStream::new_list(4);
        account_stream.append(&1u64);
        account_stream.append(&vec![0x00u8]);
        account_stream.append(&storage_root.as_slice());
        account_stream.append(&code_hash.as_slice());
        let account_rlp = account_stream.out().to_vec();

        let account_key = keccak256(&origin_mailbox);
        let account_nibbles = bytes_to_nibbles(&account_key);
        let encoded_account_path = encode_compact_path(&account_nibbles, true);

        let mut account_node_stream = RlpStream::new_list(2);
        account_node_stream.append(&encoded_account_path);
        account_node_stream.append(&account_rlp);
        let account_node = account_node_stream.out().to_vec();
        let state_root = keccak256(&account_node);

        deps.querier.update_wasm(move |q| match q {
            WasmQuery::Smart { contract_addr, .. } => {
                if contract_addr == "telepathy_light_client" {
                    let resp = crate::verify::ExecutionStateRootResponse {
                        state_root: Some(HexBinary::from(state_root.to_vec())),
                    };
                    SystemResult::Ok(ContractResult::Ok(to_json_binary(&resp).unwrap()))
                } else {
                    panic!("unexpected contract {}", contract_addr);
                }
            }
            _ => panic!("unexpected query"),
        });

        let init_msg = crate::msg::InstantiateMsg {
            owner: Some("owner".to_string()),
            light_client: "telepathy_light_client".to_string(),
            origin_mailbox: HexBinary::from(origin_mailbox.to_vec()),
            origin_domain: 1,
            urls: vec!["https://telepathy.hyperlane.xyz".to_string()],
        };
        instantiate(deps.as_mut(), mock_env(), mock_info("owner", &[]), init_msg).unwrap();

        let mut msg_bytes = Vec::new();
        msg_bytes.push(3u8); // version
        msg_bytes.extend_from_slice(&100u32.to_be_bytes()); // nonce
        msg_bytes.extend_from_slice(&1u32.to_be_bytes()); // origin domain = 1
        msg_bytes.extend_from_slice(&[0x12u8; 32]); // sender
        msg_bytes.extend_from_slice(&2u32.to_be_bytes()); // destination domain = 2
        msg_bytes.extend_from_slice(&[0x34u8; 32]); // recipient
        msg_bytes.extend_from_slice(b"payload message");

        let metadata = TelepathyMetadata {
            slot,
            origin_mailbox: Some(HexBinary::from(origin_mailbox.to_vec())),
            storage_key: HexBinary::from(storage_key.to_vec()),
            account_proof: vec![HexBinary::from(account_node)],
            storage_proof: vec![HexBinary::from(storage_node)],
            expected_value: Some(HexBinary::from(storage_val.to_vec())),
        };
        let metadata_bytes = to_json_binary(&metadata).unwrap();

        let query_verify = QueryMsg::Ism(IsmQuery::Verify {
            message: HexBinary::from(msg_bytes.clone()),
            metadata: HexBinary::from(metadata_bytes.to_vec()),
        });

        let res = query(deps.as_ref(), mock_env(), query_verify).unwrap();
        let resp: VerifyResponse = from_json(&res).unwrap();
        assert!(resp.verified);

        // Verify invalid origin domain rejects
        let mut bad_msg_bytes = msg_bytes.clone();
        bad_msg_bytes[5..9].copy_from_slice(&999u32.to_be_bytes()); // wrong origin
        let bad_query = QueryMsg::Ism(IsmQuery::Verify {
            message: HexBinary::from(bad_msg_bytes),
            metadata: HexBinary::from(metadata_bytes.to_vec()),
        });
        let res_bad = query(deps.as_ref(), mock_env(), bad_query).unwrap();
        let resp_bad: VerifyResponse = from_json(&res_bad).unwrap();
        assert!(!resp_bad.verified);
    }

    #[test]
    fn test_binary_metadata_verification() {
        let mut deps = mock_dependencies();

        let origin_mailbox = [0x33u8; 20];
        let slot = 42u64;
        let storage_key = [0x77u8; 32];
        let storage_val = [0x88u8; 32];

        let mut val_stream = RlpStream::new();
        val_stream.append(&storage_val.as_slice());
        let storage_val_rlp = val_stream.out().to_vec();

        let storage_hashed_key = keccak256(&storage_key);
        let storage_nibbles = bytes_to_nibbles(&storage_hashed_key);
        let encoded_storage_path = encode_compact_path(&storage_nibbles, true);

        let mut storage_node_stream = RlpStream::new_list(2);
        storage_node_stream.append(&encoded_storage_path);
        storage_node_stream.append(&storage_val_rlp);
        let storage_node = storage_node_stream.out().to_vec();
        let storage_root = keccak256(&storage_node);

        let code_hash = [0x99u8; 32];
        let mut account_stream = RlpStream::new_list(4);
        account_stream.append(&1u64);
        account_stream.append(&vec![0x00u8]);
        account_stream.append(&storage_root.as_slice());
        account_stream.append(&code_hash.as_slice());
        let account_rlp = account_stream.out().to_vec();

        let account_key = keccak256(&origin_mailbox);
        let account_nibbles = bytes_to_nibbles(&account_key);
        let encoded_account_path = encode_compact_path(&account_nibbles, true);

        let mut account_node_stream = RlpStream::new_list(2);
        account_node_stream.append(&encoded_account_path);
        account_node_stream.append(&account_rlp);
        let account_node = account_node_stream.out().to_vec();
        let state_root = keccak256(&account_node);

        deps.querier.update_wasm(move |q| match q {
            WasmQuery::Smart { contract_addr, .. } => {
                if contract_addr == "telepathy_light_client" {
                    let resp = crate::verify::ExecutionStateRootResponse {
                        state_root: Some(HexBinary::from(state_root.to_vec())),
                    };
                    SystemResult::Ok(ContractResult::Ok(to_json_binary(&resp).unwrap()))
                } else {
                    panic!("unexpected contract {}", contract_addr);
                }
            }
            _ => panic!("unexpected query"),
        });

        let init_msg = crate::msg::InstantiateMsg {
            owner: Some("owner".to_string()),
            light_client: "telepathy_light_client".to_string(),
            origin_mailbox: HexBinary::from(origin_mailbox.to_vec()),
            origin_domain: 1,
            urls: vec!["https://telepathy.hyperlane.xyz".to_string()],
        };
        instantiate(deps.as_mut(), mock_env(), mock_info("owner", &[]), init_msg).unwrap();

        let mut msg_bytes = Vec::new();
        msg_bytes.push(3u8);
        msg_bytes.extend_from_slice(&100u32.to_be_bytes());
        msg_bytes.extend_from_slice(&1u32.to_be_bytes());
        msg_bytes.extend_from_slice(&[0x12u8; 32]);
        msg_bytes.extend_from_slice(&2u32.to_be_bytes());
        msg_bytes.extend_from_slice(&[0x34u8; 32]);
        msg_bytes.extend_from_slice(b"payload message");

        let mut binary_meta = Vec::new();
        binary_meta.extend_from_slice(&slot.to_be_bytes());
        binary_meta.extend_from_slice(&storage_key);
        binary_meta.extend_from_slice(&1u16.to_be_bytes());
        binary_meta.extend_from_slice(&(account_node.len() as u16).to_be_bytes());
        binary_meta.extend_from_slice(&account_node);
        binary_meta.extend_from_slice(&1u16.to_be_bytes());
        binary_meta.extend_from_slice(&(storage_node.len() as u16).to_be_bytes());
        binary_meta.extend_from_slice(&storage_node);
        binary_meta.extend_from_slice(&storage_val);

        let query_verify = QueryMsg::Ism(IsmQuery::Verify {
            message: HexBinary::from(msg_bytes),
            metadata: HexBinary::from(binary_meta),
        });

        let res = query(deps.as_ref(), mock_env(), query_verify).unwrap();
        let resp: VerifyResponse = from_json(&res).unwrap();
        assert!(resp.verified);
    }
}
