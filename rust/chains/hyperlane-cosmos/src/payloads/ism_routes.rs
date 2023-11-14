use super::general::EmptyStruct;
use hyperlane_core::HyperlaneMessage;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Debug)]
pub struct IsmRouteRequest<'a> {
    route: IsmRouteRequestInner<'a>,
}

impl<'a> IsmRouteRequest<'a> {
    pub fn new(message: &'a HyperlaneMessage) -> Self {
        Self {
            route: IsmRouteRequestInner { message },
        }
    }
}

#[derive(Serialize, Debug)]
pub struct IsmRouteRequestInner<'a> {
    #[serde(with = "crate::serde::serde_hex_encoded_hyperlane_message")]
    message: &'a HyperlaneMessage,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct IsmRouteRespnose {
    pub ism: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QueryRoutingIsmGeneralRequest<T> {
    pub routing_ism: T,
}

impl<T> QueryRoutingIsmGeneralRequest<T> {
    pub fn new(inner: T) -> Self {
        Self { routing_ism: inner }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QueryRoutingIsmRouteResponse {
    pub ism: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QueryIsmGeneralRequest<T> {
    pub ism: T,
}

impl<T> QueryIsmGeneralRequest<T> {
    pub fn new(inner: T) -> Self {
        Self { ism: inner }
    }
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct QueryIsmModuleTypeRequest {
    pub module_type: EmptyStruct,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct QueryIsmModuleTypeResponse {
    #[serde(rename = "type")]
    pub typ: hpl_interface::ism::IsmType,
}
