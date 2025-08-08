use eyre::Result;
use hyperlane_core::{Decode, Encode, HyperlaneMessage, RawHyperlaneMessage};
use hyperlane_cosmos_rs::dymensionxyz::dymension::forward::HlMetadata;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::TransactionOutpoint;
use hyperlane_warp_route::TokenMessage;
use kaspa_hashes::Hash;
use prost::Message;
pub use secp256k1::Keypair as KaspaSecpKeypair;
use std::io::Cursor;

pub struct ParsedHL {
    pub hl_message: HyperlaneMessage,
    pub token_message: TokenMessage,
}

impl ParsedHL {
    pub fn parse_string(payload: &str) -> Result<Self> {
        let raw = hex::decode(payload)?;
        Self::parse_bytes(raw)
    }

    pub fn parse_bytes(payload: Vec<u8>) -> Result<Self> {
        let hl_message = parse_hyperlane_message(&payload)?;
        let token_message = parse_hyperlane_metadata(&hl_message)?;
        Ok(ParsedHL {
            hl_message,
            token_message,
        })
    }
}

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

pub fn add_kaspa_metadata_hl_messsage(
    parsed: ParsedHL,
    transaction_id: Hash,
    utxo_index: usize,
) -> Result<HyperlaneMessage> {
    let hl_message = parsed.hl_message;
    let token_message: TokenMessage = parsed.token_message;

    let output = TransactionOutpoint {
        transaction_id: transaction_id.as_bytes().to_vec(),
        index: utxo_index as u32,
    };

    let output_bytes = output.encode_to_vec();

    let mut metadata: HlMetadata;
    if token_message.metadata().is_empty() {
        metadata = HlMetadata::default();
    } else {
        metadata = HlMetadata::decode(token_message.metadata())?;
    }
    metadata.kaspa = output_bytes;

    let token_message = TokenMessage::new(
        token_message.recipient(),
        token_message.amount(),
        metadata.encode_to_vec(),
    );

    let mut hl_message: HyperlaneMessage = hl_message.clone();
    hl_message.body = token_message.to_vec();

    Ok(hl_message)
}
