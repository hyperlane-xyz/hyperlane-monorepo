use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, HexBinary};

#[cw_serde]
pub struct InstantiateMsg {
    pub owner: Option<String>,
    pub light_client: String,
    pub origin_mailbox: HexBinary,
    pub origin_domain: u32,
    pub urls: Vec<String>,
}

#[cw_serde]
pub enum ExecuteMsg {
    SetUrls {
        urls: Vec<String>,
    },
    SetLightClient {
        light_client: String,
    },
    SetOriginMailbox {
        origin_mailbox: HexBinary,
        origin_domain: u32,
    },
    TransferOwnership {
        new_owner: String,
    },
    AcceptOwnership {},
    VerifyAndExecute {
        message: HexBinary,
        metadata: HexBinary,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(IsmResponseWrapper)]
    Ism(IsmQuery),

    #[returns(ModuleTypeResponse)]
    ModuleType {},

    #[returns(VerifyResponse)]
    Verify {
        message: HexBinary,
        metadata: HexBinary,
    },

    #[returns(OffchainVerifyInfoResponse)]
    GetOffchainVerifyInfo {
        message: HexBinary,
    },

    #[returns(ConfigResponse)]
    GetConfig {},

    #[returns(UrlsResponse)]
    GetUrls {},
}

#[cw_serde]
pub enum IsmQuery {
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
pub enum IsmResponseWrapper {
    ModuleType(ModuleTypeResponse),
    Verify(VerifyResponse),
    VerifyInfo(OffchainVerifyInfoResponse),
}

#[cw_serde]
pub struct ModuleTypeResponse {
    #[serde(rename = "type")]
    pub typ: String,
}

#[cw_serde]
pub struct VerifyResponse {
    pub verified: bool,
}

#[cw_serde]
pub struct OffchainVerifyInfoResponse {
    pub urls: Vec<String>,
    pub call_data: HexBinary,
    pub extra_data: HexBinary,
}

#[cw_serde]
pub struct ConfigResponse {
    pub owner: Addr,
    pub pending_owner: Option<Addr>,
    pub light_client: Addr,
    pub origin_mailbox: HexBinary,
    pub origin_domain: u32,
    pub urls: Vec<String>,
}

#[cw_serde]
pub struct UrlsResponse {
    pub urls: Vec<String>,
}

#[cw_serde]
pub struct TelepathyMetadata {
    pub slot: u64,
    pub origin_mailbox: Option<HexBinary>,
    pub storage_key: HexBinary,
    pub account_proof: Vec<HexBinary>,
    pub storage_proof: Vec<HexBinary>,
    pub expected_value: Option<HexBinary>,
}
