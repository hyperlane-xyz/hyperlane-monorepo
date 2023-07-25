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
