use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct VerifyRequest {
    pub verify: VerifyRequestInner,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct VerifyRequestInner {
    pub metadata: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct VerifyResponse {
    pub verified: bool,
}
