pub mod api;
pub mod confirmation;
pub mod consts;
pub mod deposit;
pub mod escrow;
pub mod payload;
pub mod util;
pub mod wallet;
pub mod withdraw;

use eyre::Result;
use hyperlane_core::{Decode, HyperlaneMessage, RawHyperlaneMessage};
use hyperlane_warp_route::TokenMessage;
use kaspa_addresses::{Address, Prefix};
use kaspa_rpc_core::RpcScriptPublicKey;
use kaspa_txscript::extract_script_pub_key_address;
pub use secp256k1::Keypair as KaspaSecpKeypair;
use std::io::Cursor;

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
    let address = extract_script_pub_key_address(pk, escrow_address.prefix)?;
    if address.address_to_string() == escrow_address.address_to_string() {
        return Ok(true);
    }
    Ok(false)
}
