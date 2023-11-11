use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct VerifyInfoRequest {
    pub verify_info: VerifyInfoRequestInner,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct VerifyInfoRequestInner {
    pub message: String, // hexbinary
}
