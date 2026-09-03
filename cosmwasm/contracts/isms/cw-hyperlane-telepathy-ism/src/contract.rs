use cosmwasm_std::{
    to_json_binary, Binary, Deps, DepsMut, Env, HexBinary, MessageInfo, Response, StdResult,
};
use cw2::set_contract_version;
use cw_trie_verifier::{
    keccak256, verify_account_storage_root, verify_storage_slot_value, TrieError,
};

use crate::error::ContractError;
use crate::msg::{
    ConfigResponse, ExecuteMsg, InstantiateMsg, IsmQueryMsg, ModuleTypeResponse,
    OffchainVerifyInfoResponse, QueryMsg, VerifyInfoResponse, VerifyResponse,
};
use crate::state::{Config, CONFIG};

const CONTRACT_NAME: &str = "crates.io:cw-hyperlane-telepathy-ism";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let owner = deps.api.addr_validate(&msg.owner)?;
    let light_client_address = deps.api.addr_validate(&msg.light_client_address)?;

    if msg.dispatched_hook_address.len() != 20 && msg.dispatched_hook_address.len() != 32 {
        return Err(ContractError::InvalidAddress(
            "Dispatched hook address must be 20 or 32 bytes".to_string(),
        ));
    }

    let config = Config {
        owner,
        light_client_address,
        dispatched_hook_address: msg.dispatched_hook_address,
        origin_domain: msg.origin_domain,
        storage_slot_index: msg.storage_slot_index.unwrap_or(0),
        ccip_gateway_urls: msg.ccip_gateway_urls,
    };
    CONFIG.save(deps.storage, &config)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("origin_domain", msg.origin_domain.to_string()))
}

pub fn execute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.owner {
        return Err(ContractError::Unauthorized {});
    }

    match msg {
        ExecuteMsg::SetLightClient { address } => {
            config.light_client_address = deps.api.addr_validate(&address)?;
            CONFIG.save(deps.storage, &config)?;
            Ok(Response::new()
                .add_attribute("action", "set_light_client")
                .add_attribute("address", address))
        }
        ExecuteMsg::SetDispatchedHook { address } => {
            if address.len() != 20 && address.len() != 32 {
                return Err(ContractError::InvalidAddress(
                    "Address must be 20 or 32 bytes".to_string(),
                ));
            }
            config.dispatched_hook_address = address.clone();
            CONFIG.save(deps.storage, &config)?;
            Ok(Response::new()
                .add_attribute("action", "set_dispatched_hook")
                .add_attribute("address", address.to_hex()))
        }
        ExecuteMsg::SetCcipGateways { urls } => {
            config.ccip_gateway_urls = urls;
            CONFIG.save(deps.storage, &config)?;
            Ok(Response::new().add_attribute("action", "set_ccip_gateways"))
        }
        ExecuteMsg::SetStorageSlotIndex { index } => {
            config.storage_slot_index = index;
            CONFIG.save(deps.storage, &config)?;
            Ok(Response::new()
                .add_attribute("action", "set_storage_slot_index")
                .add_attribute("index", index.to_string()))
        }
        ExecuteMsg::TransferOwnership { new_owner } => {
            config.owner = deps.api.addr_validate(&new_owner)?;
            CONFIG.save(deps.storage, &config)?;
            Ok(Response::new()
                .add_attribute("action", "transfer_ownership")
                .add_attribute("new_owner", new_owner))
        }
    }
}

pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::ModuleType {} => to_json_binary(&query_module_type()?),
        QueryMsg::Verify { message, metadata } => {
            let res = query_verify(deps, message, metadata).unwrap_or(VerifyResponse {
                verified: false,
            });
            to_json_binary(&res)
        }
        QueryMsg::VerifyInfo { message } => to_json_binary(&query_verify_info(deps, message)?),
        QueryMsg::GetOffchainVerifyInfo { message } => {
            to_json_binary(&query_offchain_verify_info(deps, message)?)
        }
        QueryMsg::Ism(ism_msg) => match ism_msg {
            IsmQueryMsg::ModuleType {} => to_json_binary(&query_module_type()?),
            IsmQueryMsg::Verify { message, metadata } => {
                let res = query_verify(deps, message, metadata).unwrap_or(VerifyResponse {
                    verified: false,
                });
                to_json_binary(&res)
            }
            IsmQueryMsg::VerifyInfo { message } => {
                to_json_binary(&query_verify_info(deps, message)?)
            }
        },
        QueryMsg::GetConfig {} => to_json_binary(&query_config(deps)?),
    }
}

fn query_module_type() -> StdResult<ModuleTypeResponse> {
    Ok(ModuleTypeResponse {
        ism_type: "ccip_read".to_string(),
    })
}

fn query_verify_info(_deps: Deps, _message: HexBinary) -> StdResult<VerifyInfoResponse> {
    Ok(VerifyInfoResponse {
        threshold: 1,
        validators: vec![],
    })
}

fn query_offchain_verify_info(deps: Deps, message: HexBinary) -> StdResult<OffchainVerifyInfoResponse> {
    let config = CONFIG.load(deps.storage)?;
    Ok(OffchainVerifyInfoResponse {
        urls: config.ccip_gateway_urls,
        call_data: message,
    })
}

fn query_config(deps: Deps) -> StdResult<ConfigResponse> {
    let config = CONFIG.load(deps.storage)?;
    Ok(ConfigResponse {
        owner: config.owner.to_string(),
        light_client_address: config.light_client_address.to_string(),
        dispatched_hook_address: config.dispatched_hook_address,
        origin_domain: config.origin_domain,
        storage_slot_index: config.storage_slot_index,
        ccip_gateway_urls: config.ccip_gateway_urls,
    })
}

/// Parses an RLP payload into a vector of node byte arrays
fn parse_proof_nodes(raw_bytes: &[u8]) -> Result<Vec<Vec<u8>>, ContractError> {
    if raw_bytes.is_empty() {
        return Err(ContractError::InvalidMetadata("Empty proof bytes".to_string()));
    }
    let rlp = rlp::Rlp::new(raw_bytes);
    if rlp.is_list() {
        let mut nodes = Vec::new();
        for item in rlp.iter() {
            if item.is_data() {
                if let Ok(bytes) = item.data() {
                    nodes.push(bytes.to_vec());
                } else {
                    nodes.push(item.as_raw().to_vec());
                }
            } else {
                nodes.push(item.as_raw().to_vec());
            }
        }
        Ok(nodes)
    } else {
        // Individual RLP node or slice
        Ok(vec![raw_bytes.to_vec()])
    }
}

pub fn query_verify(
    deps: Deps,
    message: HexBinary,
    metadata: HexBinary,
) -> Result<VerifyResponse, ContractError> {
    if message.len() < 77 {
        return Err(ContractError::InvalidMessageLength(message.len()));
    }

    let config = CONFIG.load(deps.storage)?;

    // 1. Unpack Hyperlane message fields
    let msg_bytes = message.as_slice();
    let nonce = u32::from_be_bytes(msg_bytes[1..5].try_into().unwrap());
    let origin_domain = u32::from_be_bytes(msg_bytes[5..9].try_into().unwrap());

    if origin_domain != config.origin_domain {
        return Err(ContractError::OriginDomainMismatch {
            expected: config.origin_domain,
            actual: origin_domain,
        });
    }

    let message_id = keccak256(msg_bytes);

    // 2. Unpack Metadata
    let meta_bytes = metadata.as_slice();
    if meta_bytes.len() < 12 {
        return Err(ContractError::InvalidMetadata(
            "Metadata length must be at least 12 bytes".to_string(),
        ));
    }

    let slot = u64::from_be_bytes(meta_bytes[0..8].try_into().unwrap());
    let account_proof_len = u16::from_be_bytes(meta_bytes[8..10].try_into().unwrap()) as usize;
    let offset_account = 10;
    if meta_bytes.len() < offset_account + account_proof_len + 2 {
        return Err(ContractError::InvalidMetadata(
            "Metadata truncated before storage proof".to_string(),
        ));
    }

    let account_proof_raw = &meta_bytes[offset_account..offset_account + account_proof_len];
    let offset_storage_len = offset_account + account_proof_len;
    let storage_proof_len =
        u16::from_be_bytes(meta_bytes[offset_storage_len..offset_storage_len + 2].try_into().unwrap()) as usize;
    let offset_storage = offset_storage_len + 2;

    if meta_bytes.len() < offset_storage + storage_proof_len {
        return Err(ContractError::InvalidMetadata(
            "Metadata truncated in storage proof".to_string(),
        ));
    }

    let storage_proof_raw = &meta_bytes[offset_storage..offset_storage + storage_proof_len];

    let account_proof_nodes = parse_proof_nodes(account_proof_raw)?;
    let storage_proof_nodes = parse_proof_nodes(storage_proof_raw)?;

    // 3. Query execution state root from CosmWasm Telepathy light client
    let light_client_query = cw_telepathy_light_client::msg::QueryMsg::GetExecutionStateRoot { slot };
    let lc_res: cw_telepathy_light_client::msg::ExecutionStateRootResponse = deps
        .querier
        .query_wasm_smart(config.light_client_address.to_string(), &light_client_query)
        .map_err(|e| ContractError::Std(e))?;

    let state_root_hex = lc_res
        .execution_state_root
        .ok_or(ContractError::StateRootNotFound { slot })?;

    if state_root_hex.len() != 32 {
        return Err(ContractError::Trie(TrieError::RootMismatch {
            expected: "32 bytes".to_string(),
            actual: format!("{} bytes", state_root_hex.len()),
        }));
    }

    let mut state_root = [0u8; 32];
    state_root.copy_from_slice(state_root_hex.as_slice());

    // 4. Verify Account Trie Proof to get Storage Root
    let hook_addr_bytes = config.dispatched_hook_address.as_slice();
    let hook_20: [u8; 20] = if hook_addr_bytes.len() == 20 {
        hook_addr_bytes.try_into().unwrap()
    } else if hook_addr_bytes.len() == 32 {
        hook_addr_bytes[12..32].try_into().unwrap()
    } else {
        return Err(ContractError::InvalidAddress(
            "Dispatched hook address must be 20 or 32 bytes".to_string(),
        ));
    };

    let storage_root = verify_account_storage_root(&state_root, &hook_20, &account_proof_nodes)?;

    // 5. Calculate storage key: keccak256(abi.encode(bytes32(nonce), bytes32(storage_slot_index)))
    let mut storage_key_preimage = [0u8; 64];
    // bytes 0..28 are 0, bytes 28..32 are nonce big-endian
    storage_key_preimage[28..32].copy_from_slice(&nonce.to_be_bytes());
    // bytes 32..60 are 0, bytes 60..64 are storage_slot_index big-endian
    storage_key_preimage[60..64].copy_from_slice(&config.storage_slot_index.to_be_bytes());

    let storage_key = keccak256(&storage_key_preimage);

    // 6. Verify Storage Trie Proof: storage slot value == message_id
    let valid = verify_storage_slot_value(
        &storage_root,
        &storage_key,
        &storage_proof_nodes,
        &message_id,
    )?;

    if !valid {
        return Err(ContractError::MessageIdMismatch {});
    }

    Ok(VerifyResponse { verified: true })
}
