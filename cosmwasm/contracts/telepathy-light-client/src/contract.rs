use cosmwasm_std::{
    to_json_binary, Binary, Deps, DepsMut, Env, HexBinary, MessageInfo, Response, StdResult,
};
use cw2::set_contract_version;

use crate::error::ContractError;
use crate::msg::{
    ConfigResponse, ExecuteMsg, ExecutionStateRootResponse, HeaderRootResponse, InstantiateMsg,
    LatestSlotResponse, QueryMsg, SyncCommitteeRootResponse,
};
use crate::state::{
    Config, CONFIG, EXECUTION_STATE_ROOTS, HEADER_ROOTS, LATEST_SLOT, SYNC_COMMITTEE_ROOTS,
};

const CONTRACT_NAME: &str = "crates.io:telepathy-light-client";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let owner = msg
        .owner
        .map(|o| deps.api.addr_validate(&o))
        .transpose()?
        .unwrap_or(info.sender);

    let genesis_validators_root = msg
        .genesis_validators_root
        .unwrap_or_else(|| HexBinary::from(vec![0u8; 32]));

    if genesis_validators_root.len() != 32 {
        return Err(ContractError::InvalidHashLength {});
    }

    let config = Config {
        owner,
        pending_owner: None,
        genesis_validators_root,
        source_chain_id: msg.source_chain_id.unwrap_or(1),
    };
    CONFIG.save(deps.storage, &config)?;

    let initial_slot = msg.initial_slot.unwrap_or(0);
    LATEST_SLOT.save(deps.storage, &initial_slot)?;

    if let Some(state_root) = msg.initial_execution_state_root {
        if state_root.len() != 32 {
            return Err(ContractError::InvalidHashLength {});
        }
        EXECUTION_STATE_ROOTS.save(deps.storage, initial_slot, &state_root)?;
    }

    if let Some(header_root) = msg.initial_header_root {
        if header_root.len() != 32 {
            return Err(ContractError::InvalidHashLength {});
        }
        HEADER_ROOTS.save(deps.storage, initial_slot, &header_root)?;
    }

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("owner", config.owner)
        .add_attribute("initial_slot", initial_slot.to_string()))
}

pub fn execute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Step {
            slot,
            execution_state_root,
            header_root,
            proof,
        } => execute_step(deps, info, slot, execution_state_root, header_root, proof),
        ExecuteMsg::RotateSyncCommittee {
            period,
            next_sync_committee_root,
            proof,
        } => execute_rotate_sync_committee(deps, info, period, next_sync_committee_root, proof),
        ExecuteMsg::AddExecutionStateRoot {
            slot,
            execution_state_root,
            header_root,
        } => execute_add_state_root(deps, info, slot, execution_state_root, header_root),
        ExecuteMsg::TransferOwnership { new_owner } => {
            execute_transfer_ownership(deps, info, new_owner)
        }
        ExecuteMsg::AcceptOwnership {} => execute_accept_ownership(deps, info),
    }
}

pub fn execute_step(
    deps: DepsMut,
    _info: MessageInfo,
    slot: u64,
    execution_state_root: HexBinary,
    header_root: Option<HexBinary>,
    proof: HexBinary,
) -> Result<Response, ContractError> {
    if execution_state_root.len() != 32 {
        return Err(ContractError::InvalidHashLength {});
    }

    if proof.is_empty() {
        return Err(ContractError::InvalidProof {});
    }

    let latest_slot = LATEST_SLOT.load(deps.storage)?;
    if slot <= latest_slot && EXECUTION_STATE_ROOTS.has(deps.storage, slot) {
        return Err(ContractError::SlotNotIncreasing(slot, latest_slot));
    }

    EXECUTION_STATE_ROOTS.save(deps.storage, slot, &execution_state_root)?;
    if let Some(h_root) = &header_root {
        if h_root.len() != 32 {
            return Err(ContractError::InvalidHashLength {});
        }
        HEADER_ROOTS.save(deps.storage, slot, h_root)?;
    }

    if slot > latest_slot {
        LATEST_SLOT.save(deps.storage, &slot)?;
    }

    Ok(Response::new()
        .add_attribute("action", "step")
        .add_attribute("slot", slot.to_string())
        .add_attribute("execution_state_root", execution_state_root.to_hex()))
}

pub fn execute_rotate_sync_committee(
    deps: DepsMut,
    _info: MessageInfo,
    period: u64,
    next_sync_committee_root: HexBinary,
    proof: HexBinary,
) -> Result<Response, ContractError> {
    if next_sync_committee_root.len() != 32 {
        return Err(ContractError::InvalidHashLength {});
    }
    if proof.is_empty() {
        return Err(ContractError::InvalidProof {});
    }

    SYNC_COMMITTEE_ROOTS.save(deps.storage, period, &next_sync_committee_root)?;

    Ok(Response::new()
        .add_attribute("action", "rotate_sync_committee")
        .add_attribute("period", period.to_string())
        .add_attribute("next_sync_committee_root", next_sync_committee_root.to_hex()))
}

pub fn execute_add_state_root(
    deps: DepsMut,
    info: MessageInfo,
    slot: u64,
    execution_state_root: HexBinary,
    header_root: Option<HexBinary>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.owner {
        return Err(ContractError::Unauthorized {});
    }

    if execution_state_root.len() != 32 {
        return Err(ContractError::InvalidHashLength {});
    }

    EXECUTION_STATE_ROOTS.save(deps.storage, slot, &execution_state_root)?;

    if let Some(h_root) = &header_root {
        if h_root.len() != 32 {
            return Err(ContractError::InvalidHashLength {});
        }
        HEADER_ROOTS.save(deps.storage, slot, h_root)?;
    }

    let current_latest = LATEST_SLOT.load(deps.storage).unwrap_or(0);
    if slot > current_latest {
        LATEST_SLOT.save(deps.storage, &slot)?;
    }

    Ok(Response::new()
        .add_attribute("action", "add_execution_state_root")
        .add_attribute("slot", slot.to_string())
        .add_attribute("execution_state_root", execution_state_root.to_hex()))
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

pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::ExecutionStateRoot { slot } => {
            let state_root = EXECUTION_STATE_ROOTS.may_load(deps.storage, slot)?;
            to_json_binary(&ExecutionStateRootResponse { state_root })
        }
        QueryMsg::HeaderRoot { slot } => {
            let header_root = HEADER_ROOTS.may_load(deps.storage, slot)?;
            to_json_binary(&HeaderRootResponse { header_root })
        }
        QueryMsg::LatestSlot {} => {
            let slot = LATEST_SLOT.load(deps.storage)?;
            to_json_binary(&LatestSlotResponse { slot })
        }
        QueryMsg::SyncCommitteeRoot { period } => {
            let sync_committee_root = SYNC_COMMITTEE_ROOTS.may_load(deps.storage, period)?;
            to_json_binary(&SyncCommitteeRootResponse {
                sync_committee_root,
            })
        }
        QueryMsg::GetConfig {} => {
            let config = CONFIG.load(deps.storage)?;
            let latest_slot = LATEST_SLOT.load(deps.storage)?;
            to_json_binary(&ConfigResponse {
                owner: config.owner,
                pending_owner: config.pending_owner,
                genesis_validators_root: config.genesis_validators_root,
                source_chain_id: config.source_chain_id,
                latest_slot,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::from_json;

    #[test]
    fn test_initialization() {
        let mut deps = mock_dependencies();
        let info = mock_info("creator", &[]);
        let msg = InstantiateMsg {
            owner: Some("owner".to_string()),
            genesis_validators_root: Some(HexBinary::from(vec![0x11u8; 32])),
            source_chain_id: Some(1),
            initial_slot: Some(1000),
            initial_execution_state_root: Some(HexBinary::from(vec![0x22u8; 32])),
            initial_header_root: Some(HexBinary::from(vec![0x33u8; 32])),
        };

        let res = instantiate(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(res.attributes[0].value, "instantiate");

        let q_res = query(deps.as_ref(), mock_env(), QueryMsg::LatestSlot {}).unwrap();
        let latest: LatestSlotResponse = from_json(&q_res).unwrap();
        assert_eq!(latest.slot, 1000);

        let q_root = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::ExecutionStateRoot { slot: 1000 },
        )
        .unwrap();
        let root_res: ExecutionStateRootResponse = from_json(&q_root).unwrap();
        assert_eq!(root_res.state_root.unwrap(), HexBinary::from(vec![0x22u8; 32]));
    }

    #[test]
    fn test_step_and_admin_add() {
        let mut deps = mock_dependencies();
        let info = mock_info("owner", &[]);
        let msg = InstantiateMsg {
            owner: Some("owner".to_string()),
            genesis_validators_root: None,
            source_chain_id: None,
            initial_slot: Some(100),
            initial_execution_state_root: None,
            initial_header_root: None,
        };
        instantiate(deps.as_mut(), mock_env(), info.clone(), msg).unwrap();

        let step_msg = ExecuteMsg::Step {
            slot: 200,
            execution_state_root: HexBinary::from(vec![0x55u8; 32]),
            header_root: Some(HexBinary::from(vec![0x66u8; 32])),
            proof: HexBinary::from(vec![0x77u8; 64]),
        };
        execute(deps.as_mut(), mock_env(), mock_info("relayer", &[]), step_msg).unwrap();

        let q_res = query(deps.as_ref(), mock_env(), QueryMsg::LatestSlot {}).unwrap();
        let latest: LatestSlotResponse = from_json(&q_res).unwrap();
        assert_eq!(latest.slot, 200);

        let add_msg = ExecuteMsg::AddExecutionStateRoot {
            slot: 300,
            execution_state_root: HexBinary::from(vec![0x88u8; 32]),
            header_root: None,
        };
        execute(deps.as_mut(), mock_env(), info, add_msg).unwrap();

        let q_root = query(
            deps.as_ref(),
            mock_env(),
            QueryMsg::ExecutionStateRoot { slot: 300 },
        )
        .unwrap();
        let root_res: ExecutionStateRootResponse = from_json(&q_root).unwrap();
        assert_eq!(root_res.state_root.unwrap(), HexBinary::from(vec![0x88u8; 32]));
    }
}
