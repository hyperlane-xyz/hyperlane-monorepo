use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct ModulesAndThresholdRequest {
    pub modules_and_threshold: ModulesAndThresholdRequestInner,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ModulesAndThresholdRequestInner {
    pub message: String, // hexbinary
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ModulesAndThresholdResponse {
    pub threshold: u8,
    pub modules: Vec<String>,
}
