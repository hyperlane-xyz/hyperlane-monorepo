use std::{error::Error, io::Cursor};

use eyre::Result;
use hyperlane_core::{Decode, HyperlaneMessage, RawHyperlaneMessage};
use hyperlane_warp_route::TokenMessage;
use kaspa_addresses::Prefix;
use kaspa_rpc_core::RpcScriptPublicKey;
use kaspa_txscript::extract_script_pub_key_address;
pub use secp256k1::Keypair as KaspaSecpKeypair;

pub fn parse_hyperlane_message(m: &RawHyperlaneMessage) -> Result<HyperlaneMessage> {
    const MIN_EXPECTED_LENGTH: usize = 77;

    if m.len() < MIN_EXPECTED_LENGTH {
        return Err(eyre::eyre!("Value cannot be zero."));
    }
    let message = HyperlaneMessage::from(m);

    Ok(message)
}

pub fn parse_hyperlane_metadata(m: &HyperlaneMessage) -> Result<TokenMessage> {
    // decode token message inside  Hyperlane message
    let mut reader = Cursor::new(m.body.as_slice());
    let token_message = TokenMessage::read_from(&mut reader)
        .map_err(|e| eyre::eyre!("Failed to parse token message: {}", e))?;

    Ok(token_message)
}
