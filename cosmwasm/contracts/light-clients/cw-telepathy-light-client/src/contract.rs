use cosmwasm_std::{
    to_json_binary, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
};
use cw2::set_contract_version;

use crate::error::ContractError;
use crate::msg::{
    ConfigResponse, ExecuteMsg, ExecutionStateRootResponse, HeadResponse, InstantiateMsg,
    QueryMsg, SyncCommitteeResponse,
};
use crate::state::{Config, CONFIG, EXECUTION_STATE_ROOTS};

const CONTRACT_NAME: &str = "crates.io:cw-telepathy-light-client";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let owner = deps.api.addr_validate(&msg.owner)?;

    if msg.initial_execution_state_root.len() != 32 {
        return Err(ContractError::InvalidStateRootLength {});
    }

    let config = Config {
        owner,
        sync_committee_poseidon: msg.sync_committee_poseidon,
        head_slot: msg.initial_slot,
    };
    CONFIG.save(deps.storage, &config)?;

    if msg.initial_slot > 0 {
        EXECUTION_STATE_ROOTS.save(
            deps.storage,
            msg.initial_slot,
            &msg.initial_execution_state_root,
        )?;
    }

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("head_slot", msg.initial_slot.to_string()))
}

pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Step {
            proof,
            sync_committee_poseidon,
            slot,
            execution_state_root,
        } => execute_step(deps, env, info, proof, sync_committee_poseidon, slot, execution_state_root),
        ExecuteMsg::RotateSyncCommittee {
            proof,
            next_sync_committee_poseidon,
            slot,
        } => execute_rotate_sync_committee(deps, env, info, proof, next_sync_committee_poseidon, slot),
        ExecuteMsg::SetExecutionStateRoot {
            slot,
            execution_state_root,
        } => execute_set_execution_state_root(deps, info, slot, execution_state_root),
        ExecuteMsg::SetSyncCommitteePoseidon {
            sync_committee_poseidon,
        } => execute_set_sync_committee_poseidon(deps, info, sync_committee_poseidon),
        ExecuteMsg::TransferOwnership { new_owner } => {
            execute_transfer_ownership(deps, info, new_owner)
        }
    }
}

fn execute_step(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    proof: cosmwasm_std::HexBinary,
    sync_committee_poseidon: cosmwasm_std::HexBinary,
    slot: u64,
    execution_state_root: cosmwasm_std::HexBinary,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;

    if execution_state_root.len() != 32 {
        return Err(ContractError::InvalidStateRootLength {});
    }

    if slot == 0 {
        return Err(ContractError::InvalidSlot {});
    }

    // Verify sync committee matches active sync committee
    if sync_committee_poseidon != config.sync_committee_poseidon {
        return Err(ContractError::SyncCommitteeMismatch {});
    }

    // Verify proof is non-empty
    if proof.is_empty() {
        return Err(ContractError::InvalidProof {});
    }

    // Save execution state root for slot
    EXECUTION_STATE_ROOTS.save(deps.storage, slot, &execution_state_root)?;

    // Advance head slot if higher
    if slot > config.head_slot {
        config.head_slot = slot;
        CONFIG.save(deps.storage, &config)?;
    }

    Ok(Response::new()
        .add_attribute("action", "step")
        .add_attribute("slot", slot.to_string())
        .add_attribute("execution_state_root", execution_state_root.to_hex()))
}

fn execute_rotate_sync_committee(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    proof: cosmwasm_std::HexBinary,
    next_sync_committee_poseidon: cosmwasm_std::HexBinary,
    slot: u64,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;

    if proof.is_empty() {
        return Err(ContractError::InvalidProof {});
    }

    config.sync_committee_poseidon = next_sync_committee_poseidon.clone();
    if slot > config.head_slot {
        config.head_slot = slot;
    }
    CONFIG.save(deps.storage, &config)?;

    Ok(Response::new()
        .add_attribute("action", "rotate_sync_committee")
        .add_attribute("slot", slot.to_string())
        .add_attribute("next_sync_committee_poseidon", next_sync_committee_poseidon.to_hex()))
}

fn execute_set_execution_state_root(
    deps: DepsMut,
    info: MessageInfo,
    slot: u64,
    execution_state_root: cosmwasm_std::HexBinary,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.owner {
        return Err(ContractError::Unauthorized {});
    }

    if execution_state_root.len() != 32 {
        return Err(ContractError::InvalidStateRootLength {});
    }

    EXECUTION_STATE_ROOTS.save(deps.storage, slot, &execution_state_root)?;

    if slot > config.head_slot {
        config.head_slot = slot;
        CONFIG.save(deps.storage, &config)?;
    }

    Ok(Response::new()
        .add_attribute("action", "set_execution_state_root")
        .add_attribute("slot", slot.to_string())
        .add_attribute("execution_state_root", execution_state_root.to_hex()))
}

fn execute_set_sync_committee_poseidon(
    deps: DepsMut,
    info: MessageInfo,
    sync_committee_poseidon: cosmwasm_std::HexBinary,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.owner {
        return Err(ContractError::Unauthorized {});
    }

    config.sync_committee_poseidon = sync_committee_poseidon.clone();
    CONFIG.save(deps.storage, &config)?;

    Ok(Response::new()
        .add_attribute("action", "set_sync_committee_poseidon")
        .add_attribute("sync_committee_poseidon", sync_committee_poseidon.to_hex()))
}

fn execute_transfer_ownership(
    deps: DepsMut,
    info: MessageInfo,
    new_owner: String,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.owner {
        return Err(ContractError::Unauthorized {});
    }

    let validated_owner = deps.api.addr_validate(&new_owner)?;
    config.owner = validated_owner;
    CONFIG.save(deps.storage, &config)?;

    Ok(Response::new()
        .add_attribute("action", "transfer_ownership")
        .add_attribute("new_owner", new_owner))
}

pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetExecutionStateRoot { slot } => {
            to_json_binary(&query_execution_state_root(deps, slot)?)
        }
        QueryMsg::GetSyncCommitteePoseidon {} => {
            to_json_binary(&query_sync_committee_poseidon(deps)?)
        }
        QueryMsg::GetHead {} => to_json_binary(&query_head(deps)?),
        QueryMsg::GetConfig {} => to_json_binary(&query_config(deps)?),
    }
}

fn query_execution_state_root(deps: Deps, slot: u64) -> StdResult<ExecutionStateRootResponse> {
    let root = EXECUTION_STATE_ROOTS.may_load(deps.storage, slot)?;
    Ok(ExecutionStateRootResponse {
        slot,
        execution_state_root: root,
    })
}

fn query_sync_committee_poseidon(deps: Deps) -> StdResult<SyncCommitteeResponse> {
    let config = CONFIG.load(deps.storage)?;
    Ok(SyncCommitteeResponse {
        sync_committee_poseidon: config.sync_committee_poseidon,
    })
}

fn query_head(deps: Deps) -> StdResult<HeadResponse> {
    let config = CONFIG.load(deps.storage)?;
    Ok(HeadResponse {
        head_slot: config.head_slot,
    })
}

fn query_config(deps: Deps) -> StdResult<ConfigResponse> {
    let config = CONFIG.load(deps.storage)?;
    Ok(ConfigResponse {
        owner: config.owner.to_string(),
        sync_committee_poseidon: config.sync_committee_poseidon,
        head_slot: config.head_slot,
    })
}
