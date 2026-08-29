use super::*;
use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{
    from_json, to_json_binary, ContractResult, HexBinary, SystemResult, WasmQuery,
};
use cw_trie_verifier::key_to_nibbles;

/// Helper to generate a valid Hyperlane message
fn build_hyperlane_message(
    version: u8,
    nonce: u32,
    origin: u32,
    sender: [u8; 32],
    destination: u32,
    recipient: [u8; 32],
    body: &[u8],
) -> Vec<u8> {
    let mut msg = Vec::new();
    msg.push(version);
    msg.extend_from_slice(&nonce.to_be_bytes());
    msg.extend_from_slice(&origin.to_be_bytes());
    msg.extend_from_slice(&sender);
    msg.extend_from_slice(&destination.to_be_bytes());
    msg.extend_from_slice(&recipient);
    msg.extend_from_slice(body);
    msg
}

/// Helper to build an MPT single-leaf proof for a given 32-byte key and raw value
fn build_single_leaf_proof(key_32: &[u8; 32], value: &[u8]) -> (Vec<u8>, [u8; 32]) {
    let trie_nibbles = key_to_nibbles(key_32);
    let mut compact_path = vec![0x20];
    for chunk in trie_nibbles.chunks(2) {
        compact_path.push((chunk[0] << 4) | chunk[1]);
    }

    let mut stream = rlp::RlpStream::new_list(2);
    stream.append(&compact_path);
    stream.append(&value);
    let leaf_raw = stream.out().to_vec();
    let root_hash = cw_trie_verifier::keccak256(&leaf_raw);
    (leaf_raw, root_hash)
}

/// Helper to create RLP list of byte arrays
fn wrap_nodes_in_rlp_list(nodes: &[Vec<u8>]) -> Vec<u8> {
    let mut stream = rlp::RlpStream::new_list(nodes.len());
    for node in nodes {
        stream.append_raw(node, 1);
    }
    stream.out().to_vec()
}

#[test]
fn test_instantiate_and_config_queries() {
    let mut deps = mock_dependencies();
    let info = mock_info("admin", &[]);

    let dispatched_hook = HexBinary::from_hex("720127655fbb415c4c289c2462c8096f38abd4cc").unwrap();

    let init_msg = InstantiateMsg {
        owner: "admin".to_string(),
        light_client_address: "light_client_contract".to_string(),
        dispatched_hook_address: dispatched_hook.clone(),
        origin_domain: 17000,
        storage_slot_index: Some(0),
        ccip_gateway_urls: vec!["https://ccip.hyperlane.xyz".to_string()],
    };

    let res = instantiate(deps.as_mut(), mock_env(), info, init_msg).unwrap();
    assert_eq!(res.attributes[0].value, "instantiate");

    // ModuleType query
    let mod_bin = query(deps.as_ref(), mock_env(), QueryMsg::ModuleType {}).unwrap();
    let mod_res: ModuleTypeResponse = from_json(&mod_bin).unwrap();
    assert_eq!(mod_res.ism_type, "ccip_read");

    // Config query
    let cfg_bin = query(deps.as_ref(), mock_env(), QueryMsg::GetConfig {}).unwrap();
    let cfg_res: ConfigResponse = from_json(&cfg_bin).unwrap();
    assert_eq!(cfg_res.origin_domain, 17000);
    assert_eq!(cfg_res.owner, "admin");
    assert_eq!(cfg_res.dispatched_hook_address, dispatched_hook);

    // Offchain query
    let dummy_msg = HexBinary::from_hex("000000000100004268").unwrap();
    let off_bin = query(
        deps.as_ref(),
        mock_env(),
        QueryMsg::GetOffchainVerifyInfo {
            message: dummy_msg.clone(),
        },
    )
    .unwrap();
    let off_res: OffchainVerifyInfoResponse = from_json(&off_bin).unwrap();
    assert_eq!(off_res.urls, vec!["https://ccip.hyperlane.xyz"]);
    assert_eq!(off_res.call_data, dummy_msg);
}

#[test]
fn test_execute_admin_functions() {
    let mut deps = mock_dependencies();
    let info = mock_info("admin", &[]);

    let dispatched_hook = HexBinary::from_hex("720127655fbb415c4c289c2462c8096f38abd4cc").unwrap();

    let init_msg = InstantiateMsg {
        owner: "admin".to_string(),
        light_client_address: "light_client_contract".to_string(),
        dispatched_hook_address: dispatched_hook,
        origin_domain: 17000,
        storage_slot_index: Some(0),
        ccip_gateway_urls: vec![],
    };
    instantiate(deps.as_mut(), mock_env(), info, init_msg).unwrap();

    // Unauthorized call
    let unauth_info = mock_info("attacker", &[]);
    let set_lc_msg = ExecuteMsg::SetLightClient {
        address: "new_lc".to_string(),
    };
    let err = execute(deps.as_mut(), mock_env(), unauth_info, set_lc_msg.clone()).unwrap_err();
    assert_eq!(err, ContractError::Unauthorized {});

    // Authorized call
    let auth_info = mock_info("admin", &[]);
    execute(deps.as_mut(), mock_env(), auth_info, set_lc_msg).unwrap();

    let cfg_bin = query(deps.as_ref(), mock_env(), QueryMsg::GetConfig {}).unwrap();
    let cfg_res: ConfigResponse = from_json(&cfg_bin).unwrap();
    assert_eq!(cfg_res.light_client_address, "new_lc");
}

#[test]
fn test_full_message_verification_success() {
    let mut deps = mock_dependencies();
    let info = mock_info("admin", &[]);

    let hook_addr_hex = "720127655fbb415c4c289c2462c8096f38abd4cc";
    let hook_addr_bytes = hex::decode(hook_addr_hex).unwrap();
    let hook_addr_20: [u8; 20] = hook_addr_bytes.clone().try_into().unwrap();

    let init_msg = InstantiateMsg {
        owner: "admin".to_string(),
        light_client_address: "light_client_contract".to_string(),
        dispatched_hook_address: HexBinary::from_hex(hook_addr_hex).unwrap(),
        origin_domain: 17000,
        storage_slot_index: Some(0),
        ccip_gateway_urls: vec!["https://ccip.hyperlane.xyz".to_string()],
    };
    instantiate(deps.as_mut(), mock_env(), info, init_msg).unwrap();

    // Construct genuine Hyperlane message
    let nonce = 42u32;
    let origin = 17000u32;
    let sender = [0x11u8; 32];
    let destination = 1337u32;
    let recipient = [0x22u8; 32];
    let body = b"Hello from Holesky to CosmWasm!";
    let message_bytes = build_hyperlane_message(3, nonce, origin, sender, destination, recipient, body);
    let message_id = cw_trie_verifier::keccak256(&message_bytes);

    // 1. Build Storage Trie Proof for dispatched[nonce] == message_id
    let mut storage_key_preimage = [0u8; 64];
    storage_key_preimage[28..32].copy_from_slice(&nonce.to_be_bytes()); // nonce at bytes 28..32
    storage_key_preimage[60..64].copy_from_slice(&0u32.to_be_bytes());  // slot index 0 at bytes 60..64
    let storage_key_32 = cw_trie_verifier::keccak256(&storage_key_preimage);
    let storage_trie_key = cw_trie_verifier::keccak256(&storage_key_32);

    let mut val_stream = rlp::RlpStream::new();
    val_stream.append(&message_id.as_ref());
    let rlp_storage_val = val_stream.out().to_vec();

    let (storage_leaf_raw, storage_root) = build_single_leaf_proof(&storage_trie_key, &rlp_storage_val);

    // 2. Build Account Trie Proof for DispatchedHook containing storage_root
    let mut account_stream = rlp::RlpStream::new_list(4);
    account_stream.append(&1u64);                 // nonce
    account_stream.append(&0u64);                 // balance
    account_stream.append(&storage_root.as_ref()); // storage root
    account_stream.append(&[0u8; 32].as_ref());   // code hash
    let account_rlp = account_stream.out().to_vec();

    let account_trie_key = cw_trie_verifier::keccak256(&hook_addr_20);
    let (account_leaf_raw, state_root) = build_single_leaf_proof(&account_trie_key, &account_rlp);

    // Mock light client state root query
    let target_slot = 987654u64;
    deps.querier.update_wasm(move |q| match q {
        WasmQuery::Smart { contract_addr, msg } => {
            if contract_addr == "light_client_contract" {
                let parsed: cw_telepathy_light_client::msg::QueryMsg = from_json(msg).unwrap();
                if let cw_telepathy_light_client::msg::QueryMsg::GetExecutionStateRoot { slot } = parsed {
                    if slot == target_slot {
                        let response = cw_telepathy_light_client::msg::ExecutionStateRootResponse {
                            slot: target_slot,
                            execution_state_root: Some(HexBinary::from(state_root.to_vec())),
                        };
                        return SystemResult::Ok(ContractResult::Ok(to_json_binary(&response).unwrap()));
                    }
                }
            }
            SystemResult::Err(cosmwasm_std::SystemError::NoSuchContract {
                addr: contract_addr.clone(),
            })
        }
        _ => SystemResult::Err(cosmwasm_std::SystemError::Unknown {}),
    });

    // 3. Pack Metadata
    let account_proof_bytes = wrap_nodes_in_rlp_list(&[account_leaf_raw]);
    let storage_proof_bytes = wrap_nodes_in_rlp_list(&[storage_leaf_raw]);

    let mut metadata = Vec::new();
    metadata.extend_from_slice(&target_slot.to_be_bytes());
    metadata.extend_from_slice(&(account_proof_bytes.len() as u16).to_be_bytes());
    metadata.extend_from_slice(&account_proof_bytes);
    metadata.extend_from_slice(&(storage_proof_bytes.len() as u16).to_be_bytes());
    metadata.extend_from_slice(&storage_proof_bytes);

    // 4. Query Verify
    let verify_query = QueryMsg::Verify {
        message: HexBinary::from(message_bytes.clone()),
        metadata: HexBinary::from(metadata.clone()),
    };

    let bin = query(deps.as_ref(), mock_env(), verify_query).unwrap();
    let res: VerifyResponse = from_json(&bin).unwrap();
    assert!(res.verified);

    // 5. Test with Ism wrapper Query
    let ism_verify_query = QueryMsg::Ism(IsmQueryMsg::Verify {
        message: HexBinary::from(message_bytes.clone()),
        metadata: HexBinary::from(metadata.clone()),
    });
    let ism_bin = query(deps.as_ref(), mock_env(), ism_verify_query).unwrap();
    let ism_res: VerifyResponse = from_json(&ism_bin).unwrap();
    assert!(ism_res.verified);
}

#[test]
fn test_verification_fails_on_tampered_message() {
    let mut deps = mock_dependencies();
    let info = mock_info("admin", &[]);

    let hook_addr_hex = "720127655fbb415c4c289c2462c8096f38abd4cc";
    let hook_addr_bytes = hex::decode(hook_addr_hex).unwrap();
    let hook_addr_20: [u8; 20] = hook_addr_bytes.clone().try_into().unwrap();

    let init_msg = InstantiateMsg {
        owner: "admin".to_string(),
        light_client_address: "light_client_contract".to_string(),
        dispatched_hook_address: HexBinary::from_hex(hook_addr_hex).unwrap(),
        origin_domain: 17000,
        storage_slot_index: Some(0),
        ccip_gateway_urls: vec![],
    };
    instantiate(deps.as_mut(), mock_env(), info, init_msg).unwrap();

    let nonce = 42u32;
    let origin = 17000u32;
    let sender = [0x11u8; 32];
    let destination = 1337u32;
    let recipient = [0x22u8; 32];
    let body = b"Legitimate message body";
    let message_bytes = build_hyperlane_message(3, nonce, origin, sender, destination, recipient, body);
    let message_id = cw_trie_verifier::keccak256(&message_bytes);

    let mut storage_key_preimage = [0u8; 64];
    storage_key_preimage[28..32].copy_from_slice(&nonce.to_be_bytes());
    storage_key_preimage[60..64].copy_from_slice(&0u32.to_be_bytes());
    let storage_key_32 = cw_trie_verifier::keccak256(&storage_key_preimage);
    let storage_trie_key = cw_trie_verifier::keccak256(&storage_key_32);

    let mut val_stream = rlp::RlpStream::new();
    val_stream.append(&message_id.as_ref());
    let rlp_storage_val = val_stream.out().to_vec();

    let (storage_leaf_raw, storage_root) = build_single_leaf_proof(&storage_trie_key, &rlp_storage_val);

    let mut account_stream = rlp::RlpStream::new_list(4);
    account_stream.append(&1u64);
    account_stream.append(&0u64);
    account_stream.append(&storage_root.as_ref());
    account_stream.append(&[0u8; 32].as_ref());
    let account_rlp = account_stream.out().to_vec();

    let account_trie_key = cw_trie_verifier::keccak256(&hook_addr_20);
    let (account_leaf_raw, state_root) = build_single_leaf_proof(&account_trie_key, &account_rlp);

    let target_slot = 987654u64;
    deps.querier.update_wasm(move |q| match q {
        WasmQuery::Smart { contract_addr, msg: _ } => {
            if contract_addr == "light_client_contract" {
                let response = cw_telepathy_light_client::msg::ExecutionStateRootResponse {
                    slot: target_slot,
                    execution_state_root: Some(HexBinary::from(state_root.to_vec())),
                };
                return SystemResult::Ok(ContractResult::Ok(to_json_binary(&response).unwrap()));
            }
            SystemResult::Err(cosmwasm_std::SystemError::Unknown {})
        }
        _ => SystemResult::Err(cosmwasm_std::SystemError::Unknown {}),
    });

    let account_proof_bytes = wrap_nodes_in_rlp_list(&[account_leaf_raw]);
    let storage_proof_bytes = wrap_nodes_in_rlp_list(&[storage_leaf_raw]);

    let mut metadata = Vec::new();
    metadata.extend_from_slice(&target_slot.to_be_bytes());
    metadata.extend_from_slice(&(account_proof_bytes.len() as u16).to_be_bytes());
    metadata.extend_from_slice(&account_proof_bytes);
    metadata.extend_from_slice(&(storage_proof_bytes.len() as u16).to_be_bytes());
    metadata.extend_from_slice(&storage_proof_bytes);

    // Tampered message body (attacker changed recipient or body)
    let tampered_msg_bytes = build_hyperlane_message(3, nonce, origin, sender, destination, recipient, b"TAMPERED DATA");
    let verify_query = QueryMsg::Verify {
        message: HexBinary::from(tampered_msg_bytes),
        metadata: HexBinary::from(metadata.clone()),
    };

    let bin = query(deps.as_ref(), mock_env(), verify_query).unwrap();
    let res: VerifyResponse = from_json(&bin).unwrap();
    assert!(!res.verified, "Tampered message MUST NOT verify");
}

#[test]
fn test_verification_fails_on_wrong_origin_domain() {
    let mut deps = mock_dependencies();
    let info = mock_info("admin", &[]);

    let hook_addr_hex = "720127655fbb415c4c289c2462c8096f38abd4cc";

    let init_msg = InstantiateMsg {
        owner: "admin".to_string(),
        light_client_address: "light_client_contract".to_string(),
        dispatched_hook_address: HexBinary::from_hex(hook_addr_hex).unwrap(),
        origin_domain: 17000,
        storage_slot_index: Some(0),
        ccip_gateway_urls: vec![],
    };
    instantiate(deps.as_mut(), mock_env(), info, init_msg).unwrap();

    // Message from wrong origin domain (e.g. 1 instead of 17000)
    let message_bytes = build_hyperlane_message(3, 1, 1, [0u8; 32], 1337, [0u8; 32], b"hello");
    let metadata = vec![0u8; 30];

    let verify_query = QueryMsg::Verify {
        message: HexBinary::from(message_bytes),
        metadata: HexBinary::from(metadata),
    };

    let bin = query(deps.as_ref(), mock_env(), verify_query).unwrap();
    let res: VerifyResponse = from_json(&bin).unwrap();
    assert!(!res.verified);
}
