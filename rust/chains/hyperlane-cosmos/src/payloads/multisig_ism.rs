use hyperlane_core::HyperlaneMessage;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Debug)]
pub struct VerifyInfoRequest<'a> {
    verify_info: VerifyInfoRequestInner<'a>,
}

impl<'a> VerifyInfoRequest<'a> {
    pub fn new(message: &'a HyperlaneMessage) -> Self {
        Self {
            verify_info: VerifyInfoRequestInner { message },
        }
    }
}

#[derive(Serialize, Debug)]
struct VerifyInfoRequestInner<'a> {
    #[serde(with = "crate::serde::serde_hex_encoded_hyperlane_message")]
    message: &'a HyperlaneMessage,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct VerifyInfoResponse {
    pub threshold: u8,
    pub validators: Vec<String>,
}
