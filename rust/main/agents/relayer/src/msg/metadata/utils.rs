use eyre::Result;
use hyperlane_core::HyperlaneMessage;
use reqwest;
use serde::Deserialize;

/// Magic number prefix for FSR directive messages.
/// This is a protocol constant used to identify valid FSR directives.
/// Not a secret - this value is part of the public protocol specification.
/// MAGIC_NUMBER = 0xFAF09B8DEEC3D47AB5A2F9007ED1C8AD83E602B7FDAA1C47589F370CDA6BF2E1
pub const MAGIC_NUMBER: [u8; 32] = [
    0xFA, 0xF0, 0x9B, 0x8D, 0xEE, 0xC3, 0xD4, 0x7A, 0xB5, 0xA2, 0xF9, 0x00, 0x7E, 0xD1, 0xC8, 0xAD,
    0x83, 0xE6, 0x02, 0xB7, 0xFD, 0xAA, 0x1C, 0x47, 0x58, 0x9F, 0x37, 0x0C, 0xDA, 0x6B, 0xF2, 0xE1,
];

/// TODO: Support multiple environments.
/// GitHub raw content URL for FSR config
pub const FSR_CONFIG_URL: &str = "https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-monorepo/main/rust/main/config/fsr/devnet.json";

/// FSR config structure
#[derive(Debug, Deserialize)]
pub struct FSRConfig {
    pub fsr_server_url: String,
}

/// Fetch and parse the FSR config from GitHub
pub async fn fetch_fsr_config() -> Result<FSRConfig> {
    let response = reqwest::get(FSR_CONFIG_URL).await?;
    let config: FSRConfig = response.json().await?;
    Ok(config)
}

/// Checks if a message is a directive by matching the magic number prefix
/// The format of directive messages is [MAGIC_NUMBER, DIRECTIVE]
/// A magic number prefix followed by a list of directives.
pub fn is_directive(message: &HyperlaneMessage) -> bool {
    // Check if the body starts with '['
    if message.body.is_empty() || message.body[0] != b'[' {
        return false;
    }

    // Skip the '[' character and check the magic number
    if message.body.len() < MAGIC_NUMBER.len() + 1 {
        return false;
    }

    // Compare the magic number bytes
    message.body[1..=MAGIC_NUMBER.len()] == MAGIC_NUMBER
}
