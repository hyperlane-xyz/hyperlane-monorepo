use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, HexBinary};

#[cw_serde]
pub struct InstantiateMsg {
    pub owner: Option<String>,
    pub genesis_validators_root: Option<HexBinary>,
    pub source_chain_id: Option<u64>,
    pub initial_slot: Option<u64>,
    pub initial_execution_state_root: Option<HexBinary>,
    pub initial_header_root: Option<HexBinary>,
}

#[cw_serde]
pub enum ExecuteMsg {
    Step {
        slot: u64,
        execution_state_root: HexBinary,
        header_root: Option<HexBinary>,
        proof: HexBinary,
    },
    RotateSyncCommittee {
        period: u64,
        next_sync_committee_root: HexBinary,
        proof: HexBinary,
    },
    AddExecutionStateRoot {
        slot: u64,
        execution_state_root: HexBinary,
        header_root: Option<HexBinary>,
    },
    TransferOwnership {
        new_owner: String,
    },
    AcceptOwnership {},
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ExecutionStateRootResponse)]
    ExecutionStateRoot { slot: u64 },

    #[returns(HeaderRootResponse)]
    HeaderRoot { slot: u64 },

    #[returns(LatestSlotResponse)]
    LatestSlot {},

    #[returns(SyncCommitteeRootResponse)]
    SyncCommitteeRoot { period: u64 },

    #[returns(ConfigResponse)]
    GetConfig {},
}

#[cw_serde]
pub struct ExecutionStateRootResponse {
    pub state_root: Option<HexBinary>,
}

#[cw_serde]
pub struct HeaderRootResponse {
    pub header_root: Option<HexBinary>,
}

#[cw_serde]
pub struct LatestSlotResponse {
    pub slot: u64,
}

#[cw_serde]
pub struct SyncCommitteeRootResponse {
    pub sync_committee_root: Option<HexBinary>,
}

#[cw_serde]
pub struct ConfigResponse {
    pub owner: Addr,
    pub pending_owner: Option<Addr>,
    pub genesis_validators_root: HexBinary,
    pub source_chain_id: u64,
    pub latest_slot: u64,
}
