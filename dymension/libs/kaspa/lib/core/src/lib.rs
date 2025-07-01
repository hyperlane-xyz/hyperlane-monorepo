pub mod api;
pub mod confirmation;
pub mod deposit;
pub mod escrow;
pub mod util;
pub mod wallet;
pub mod withdraw;
pub mod payload;
pub mod consts;
use std::io::Cursor;

use hyperlane_core::{RawHyperlaneMessage,HyperlaneMessage,Decode};
use hyperlane_warp_route::TokenMessage;
use kaspa_addresses::{Prefix,Address};
use kaspa_rpc_core::RpcScriptPublicKey;
pub use secp256k1::Keypair as KaspaSecpKeypair;
use kaspa_txscript::extract_script_pub_key_address;
use eyre::Result;

pub fn parse_hyperlane_message(m: &RawHyperlaneMessage) -> Result<HyperlaneMessage, anyhow::Error> {
    const MIN_EXPECTED_LENGTH: usize = 77;

    if m.len() < MIN_EXPECTED_LENGTH {
        return Err(anyhow::Error::msg("Value cannot be zero."));
    }
    let message = HyperlaneMessage::from(m);

    Ok(message)
}

pub fn parse_hyperlane_metadata(m: &HyperlaneMessage) -> Result<TokenMessage, anyhow::Error> {
    // decode token message inside  Hyperlane message
    let mut reader = Cursor::new(m.body.as_slice());
    let token_message = TokenMessage::read_from(&mut reader)?;

    Ok(token_message)
}

pub fn is_utxo_escrow_address(pk: &RpcScriptPublicKey, escrow_address: &Address) -> Result<bool> {
    let address = extract_script_pub_key_address(pk, Prefix::Testnet)?;
    if address.address_to_string() == escrow_address.address_to_string() {
        return Ok(true);
    }
    Ok(false)
}
