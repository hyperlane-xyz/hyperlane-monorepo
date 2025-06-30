pub mod api;
pub mod confirmation;
pub mod deposit;
pub mod escrow;
pub mod util;
pub mod wallet;
pub mod withdraw;
pub mod payload;
pub mod consts;
use std::{error::Error, io::Cursor};

use hyperlane_core::{RawHyperlaneMessage,HyperlaneMessage,Decode};
use hyperlane_warp_route::TokenMessage;
use kaspa_addresses::Prefix;
use kaspa_rpc_core::RpcScriptPublicKey;
pub use secp256k1::Keypair as KaspaSecpKeypair;
use kaspa_txscript::extract_script_pub_key_address;

pub const ESCROW_ADDRESS: &'static str =
    "kaspatest:qzwyrgapjnhtjqkxdrmp7fpm3yddw296v2ajv9nmgmw5k3z0r38guevxyk7j0";


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

pub fn is_utxo_escrow_address(pk: &RpcScriptPublicKey) -> Result<bool, Box<dyn Error>> {
    let address = extract_script_pub_key_address(pk, Prefix::Testnet)?;
    if address.to_string() == ESCROW_ADDRESS {
        return Ok(true);
    }
    Ok(false)
}
