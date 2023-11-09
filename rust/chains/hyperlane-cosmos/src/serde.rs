/// For serializing and deserializing Pubkey
pub(crate) mod serde_hex_encoded_hyperlane_message {
    use hyperlane_core::{Decode, HyperlaneMessage, RawHyperlaneMessage};
    use serde::{Deserialize, Deserializer, Serializer};
    use std::io::Cursor;

    pub fn serialize<S: Serializer>(message: &HyperlaneMessage, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&hex::encode(RawHyperlaneMessage::from(message)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<HyperlaneMessage, D::Error> {
        String::deserialize(de).and_then(|str| {
            let mut reader = Cursor::new(hex::decode(str).map_err(serde::de::Error::custom)?);
            HyperlaneMessage::read_from(&mut reader).map_err(serde::de::Error::custom)
        })
    }
}
