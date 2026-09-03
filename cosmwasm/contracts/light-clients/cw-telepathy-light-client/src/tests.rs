use super::*;
use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
use cosmwasm_std::{from_json, HexBinary};

#[test]
fn test_instantiate_and_query_light_client() {
    let mut deps = mock_dependencies();
    let info = mock_info("creator", &[]);

    let sync_committee_poseidon = HexBinary::from_hex("11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff").unwrap();
    let initial_root = HexBinary::from_hex("000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f").unwrap();

    let instantiate_msg = InstantiateMsg {
        owner: "creator".to_string(),
        sync_committee_poseidon: sync_committee_poseidon.clone(),
        initial_slot: 100,
        initial_execution_state_root: initial_root.clone(),
    };

    let res = instantiate(deps.as_mut(), mock_env(), info, instantiate_msg).unwrap();
    assert_eq!(res.attributes[0].value, "instantiate");

    // Query config
    let config_bin = query(deps.as_ref(), mock_env(), QueryMsg::GetConfig {}).unwrap();
    let config_res: ConfigResponse = from_json(&config_bin).unwrap();
    assert_eq!(config_res.owner, "creator");
    assert_eq!(config_res.head_slot, 100);
    assert_eq!(config_res.sync_committee_poseidon, sync_committee_poseidon);

    // Query execution state root for initial slot
    let root_bin = query(deps.as_ref(), mock_env(), QueryMsg::GetExecutionStateRoot { slot: 100 }).unwrap();
    let root_res: ExecutionStateRootResponse = from_json(&root_bin).unwrap();
    assert_eq!(root_res.execution_state_root, Some(initial_root));

    // Query non-existent slot
    let missing_bin = query(deps.as_ref(), mock_env(), QueryMsg::GetExecutionStateRoot { slot: 101 }).unwrap();
    let missing_res: ExecutionStateRootResponse = from_json(&missing_bin).unwrap();
    assert_eq!(missing_res.execution_state_root, None);
}

#[test]
fn test_step_light_client() {
    let mut deps = mock_dependencies();
    let info = mock_info("creator", &[]);

    let sync_committee_poseidon = HexBinary::from_hex("11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff").unwrap();
    let initial_root = HexBinary::from_hex("000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f").unwrap();

    let instantiate_msg = InstantiateMsg {
        owner: "creator".to_string(),
        sync_committee_poseidon: sync_committee_poseidon.clone(),
        initial_slot: 100,
        initial_execution_state_root: initial_root,
    };
    instantiate(deps.as_mut(), mock_env(), info, instantiate_msg).unwrap();

    let new_root = HexBinary::from_hex("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899").unwrap();
    let proof = HexBinary::from_hex("deadbeef").unwrap();

    let step_msg = ExecuteMsg::Step {
        proof,
        sync_committee_poseidon: sync_committee_poseidon.clone(),
        slot: 132,
        execution_state_root: new_root.clone(),
    };

    let caller_info = mock_info("relayer", &[]);
    let res = execute(deps.as_mut(), mock_env(), caller_info, step_msg).unwrap();
    assert_eq!(res.attributes[0].value, "step");

    // Verify head slot updated
    let head_bin = query(deps.as_ref(), mock_env(), QueryMsg::GetHead {}).unwrap();
    let head_res: HeadResponse = from_json(&head_bin).unwrap();
    assert_eq!(head_res.head_slot, 132);

    // Verify execution root stored
    let root_bin = query(deps.as_ref(), mock_env(), QueryMsg::GetExecutionStateRoot { slot: 132 }).unwrap();
    let root_res: ExecutionStateRootResponse = from_json(&root_bin).unwrap();
    assert_eq!(root_res.execution_state_root, Some(new_root));
}

#[test]
fn test_set_execution_state_root_by_owner() {
    let mut deps = mock_dependencies();
    let info = mock_info("creator", &[]);

    let sync_committee_poseidon = HexBinary::from_hex("11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff").unwrap();
    let initial_root = HexBinary::from_hex("000102030405060708090a0b0c0d0e0f000102030405060708090a0b0c0d0e0f").unwrap();

    let instantiate_msg = InstantiateMsg {
        owner: "creator".to_string(),
        sync_committee_poseidon,
        initial_slot: 100,
        initial_execution_state_root: initial_root,
    };
    instantiate(deps.as_mut(), mock_env(), info, instantiate_msg).unwrap();

    let test_root = HexBinary::from_hex("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff").unwrap();

    // Unauthorized attempt
    let unauth_info = mock_info("attacker", &[]);
    let set_msg = ExecuteMsg::SetExecutionStateRoot {
        slot: 150,
        execution_state_root: test_root.clone(),
    };
    let err = execute(deps.as_mut(), mock_env(), unauth_info, set_msg.clone()).unwrap_err();
    assert_eq!(err, ContractError::Unauthorized {});

    // Authorized attempt
    let auth_info = mock_info("creator", &[]);
    execute(deps.as_mut(), mock_env(), auth_info, set_msg).unwrap();

    let root_bin = query(deps.as_ref(), mock_env(), QueryMsg::GetExecutionStateRoot { slot: 150 }).unwrap();
    let root_res: ExecutionStateRootResponse = from_json(&root_bin).unwrap();
    assert_eq!(root_res.execution_state_root, Some(test_root));
}
