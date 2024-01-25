use super::general::EmptyStruct;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct IsmRouteRequest {
    pub route: IsmRouteRequestInner,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct IsmRouteRequestInner {
    pub message: String, // hexbinary
}

#[derive(Serialize, Deserialize, Debug)]
pub struct IsmRouteRespnose {
    pub ism: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QueryRoutingIsmGeneralRequest<T> {
    pub routing_ism: T,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QueryRoutingIsmRouteResponse {
    pub ism: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QueryIsmGeneralRequest<T> {
    pub ism: T,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QueryIsmModuleTypeRequest {
    pub module_type: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QueryIsmModuleTypeResponse {
    #[serde(rename = "type")]
    pub typ: hpl_interface::ism::IsmType,
}
