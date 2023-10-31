use hyperlane_core::{HyperlaneMessage, RawHyperlaneMessage};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct ModulesAndThresholdRequest {
    modules_and_threshold: ModulesAndThresholdRequestInner,
}

impl ModulesAndThresholdRequest {
    pub fn new(message: &HyperlaneMessage) -> Self {
        Self {
            modules_and_threshold: ModulesAndThresholdRequestInner {
                message: hex::encode(RawHyperlaneMessage::from(message)),
            },
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct ModulesAndThresholdRequestInner {
    /// Hex-encoded Hyperlane message
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ModulesAndThresholdResponse {
    pub threshold: u8,
    /// Bech32-encoded module addresses
    pub modules: Vec<String>,
}
