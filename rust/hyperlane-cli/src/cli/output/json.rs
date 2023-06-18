use crate::cli::output::OutputWriter;
use ethers::abi::AbiEncode;
use ethers::utils::__serde_json::to_string_pretty;
use hyperlane_core::HyperlaneMessage;
use serde::Serialize;

pub struct JsonOutput {
    pub messages: Vec<HyperlaneMessage>,
}

impl OutputWriter for JsonOutput {
    fn print(&self) {
        let hyperlane_messages: Vec<HyperlaneMessageJson> = self
            .messages
            .iter()
            .map(|msg| HyperlaneMessageJson {
                version: msg.version,
                nonce: msg.nonce,
                origin: msg.origin,
                sender: self.format_address(msg.sender),
                destination: msg.destination,
                recipient: self.format_address(msg.recipient),
                body: msg.body.clone().encode_hex(),
            })
            .collect();

        if let Ok(json) = to_string_pretty(&hyperlane_messages) {
            println!("{}", json);
        }
    }
}

#[derive(Serialize)]
pub struct HyperlaneMessageJson {
    pub version: u8,
    pub nonce: u32,
    pub origin: u32,
    pub sender: String,
    pub destination: u32,
    pub recipient: String,
    pub body: String,
}
