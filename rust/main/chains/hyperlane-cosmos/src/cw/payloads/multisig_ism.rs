use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VerifyInfoRequest {
    pub verify_info: VerifyInfoRequestInner,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VerifyInfoRequestInner {
    pub message: String, // hexbinary
}

#[derive(Serialize, Deserialize, Debug)]
pub struct VerifyInfoResponse {
    pub threshold: u8,
    pub validators: Vec<String>,
}
