use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::HexBinary;

#[cw_serde]
pub struct InstantiateMsg {
    pub owner: String,
    pub sync_committee_poseidon: HexBinary,
    pub initial_slot: u64,
    pub initial_execution_state_root: HexBinary,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Step light client with Telepathy / SP1 proof of consensus update
    Step {
        proof: HexBinary,
        sync_committee_poseidon: HexBinary,
        slot: u64,
        execution_state_root: HexBinary,
    },
    /// Rotate sync committee
    RotateSyncCommittee {
        proof: HexBinary,
        next_sync_committee_poseidon: HexBinary,
        slot: u64,
    },
    /// Owner/Admin method to set execution state root (for testnet relayer / testing)
    SetExecutionStateRoot {
        slot: u64,
        execution_state_root: HexBinary,
    },
    /// Update sync committee hash directly by owner
    SetSyncCommitteePoseidon {
        sync_committee_poseidon: HexBinary,
    },
    /// Transfer ownership
    TransferOwnership {
        new_owner: String,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ExecutionStateRootResponse)]
    GetExecutionStateRoot { slot: u64 },

    #[returns(SyncCommitteeResponse)]
    GetSyncCommitteePoseidon {},

    #[returns(HeadResponse)]
    GetHead {},

    #[returns(ConfigResponse)]
    GetConfig {},
}

#[cw_serde]
pub struct ExecutionStateRootResponse {
    pub slot: u64,
    pub execution_state_root: Option<HexBinary>,
}

#[cw_serde]
pub struct SyncCommitteeResponse {
    pub sync_committee_poseidon: HexBinary,
}

#[cw_serde]
pub struct HeadResponse {
    pub head_slot: u64,
}

#[cw_serde]
pub struct ConfigResponse {
    pub owner: String,
    pub sync_committee_poseidon: HexBinary,
    pub head_slot: u64,
}
