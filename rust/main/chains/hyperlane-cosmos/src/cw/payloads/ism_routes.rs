use super::general::EmptyStruct;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IsmRouteRequest {
    pub route: IsmRouteRequestInner,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IsmRouteRequestInner {
    pub message: String, // hexbinary
}

#[derive(Serialize, Deserialize, Debug)]
pub struct IsmRouteRespnose {
    pub ism: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct QueryRoutingIsmGeneralRequest<T> {
    pub routing_ism: T,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct QueryRoutingIsmRouteResponse {
    pub ism: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct QueryIsmGeneralRequest<T> {
    pub ism: T,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct QueryIsmModuleTypeRequest {
    pub module_type: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QueryIsmModuleTypeResponse {
    #[serde(rename = "type")]
    pub typ: hyperlane_cosmwasm_interface::ism::IsmType,
}
