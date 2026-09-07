use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::HexBinary;

#[cw_serde]
pub struct InstantiateMsg {
    pub owner: String,
    pub light_client_address: String,
    pub dispatched_hook_address: HexBinary,
    pub origin_domain: u32,
    pub storage_slot_index: Option<u32>,
    pub ccip_gateway_urls: Vec<String>,
}

#[cw_serde]
pub enum ExecuteMsg {
    SetLightClient { address: String },
    SetDispatchedHook { address: HexBinary },
    SetCcipGateways { urls: Vec<String> },
    SetStorageSlotIndex { index: u32 },
    TransferOwnership { new_owner: String },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Hyperlane ISM standard query interface
    #[returns(ModuleTypeResponse)]
    ModuleType {},

    #[returns(VerifyResponse)]
    Verify {
        message: HexBinary,
        metadata: HexBinary,
    },

    #[returns(VerifyInfoResponse)]
    VerifyInfo {
        message: HexBinary,
    },

    /// CCIP-read offchain query interface
    #[returns(OffchainVerifyInfoResponse)]
    GetOffchainVerifyInfo {
        message: HexBinary,
    },

    /// General ISM routing / wrapper compatibility query
    #[returns(ModuleTypeResponse)]
    Ism(IsmQueryMsg),

    #[returns(ConfigResponse)]
    GetConfig {},
}

#[cw_serde]
pub enum IsmQueryMsg {
    ModuleType {},
    Verify {
        message: HexBinary,
        metadata: HexBinary,
    },
    VerifyInfo {
        message: HexBinary,
    },
}

#[cw_serde]
pub struct ModuleTypeResponse {
    #[serde(rename = "type")]
    pub ism_type: String,
}

#[cw_serde]
pub struct VerifyResponse {
    pub verified: bool,
}

#[cw_serde]
pub struct VerifyInfoResponse {
    pub threshold: u32,
    pub validators: Vec<HexBinary>,
}

#[cw_serde]
pub struct OffchainVerifyInfoResponse {
    pub urls: Vec<String>,
    pub call_data: HexBinary,
}

#[cw_serde]
pub struct ConfigResponse {
    pub owner: String,
    pub light_client_address: String,
    pub dispatched_hook_address: HexBinary,
    pub origin_domain: u32,
    pub storage_slot_index: u32,
    pub ccip_gateway_urls: Vec<String>,
}
