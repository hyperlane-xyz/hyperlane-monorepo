/// For serializing and deserializing Pubkey
pub(crate) mod serde_pubkey {
    use borsh::BorshDeserialize;
    use serde::{Deserialize, Deserializer, Serializer};
    use solana_sdk::pubkey::Pubkey;
    use std::str::FromStr;

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum RawPubkey {
        String(String),
        Bytes(Vec<u8>),
    }

    pub fn serialize<S: Serializer>(k: &Pubkey, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&k.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Pubkey, D::Error> {
        match RawPubkey::deserialize(de)? {
            RawPubkey::String(s) => Pubkey::from_str(&s).map_err(serde::de::Error::custom),
            RawPubkey::Bytes(b) => Pubkey::try_from_slice(&b).map_err(serde::de::Error::custom),
        }
    }
}

/// For serializing and deserializing Option<Pubkey>
pub(crate) mod serde_option_pubkey {
    use borsh::BorshDeserialize;
    use serde::{Deserialize, Deserializer, Serializer};
    use solana_sdk::pubkey::Pubkey;
    use std::str::FromStr;

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum RawPubkey {
        String(String),
        Bytes(Vec<u8>),
    }

    pub fn serialize<S: Serializer>(k: &Option<Pubkey>, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&k.map(|k| k.to_string()).unwrap_or_default())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Option<Pubkey>, D::Error> {
        match Option::<RawPubkey>::deserialize(de)? {
            Some(RawPubkey::String(s)) => {
                if s.is_empty() {
                    Ok(None)
                } else {
                    Pubkey::from_str(&s)
                        .map_err(serde::de::Error::custom)
                        .map(Some)
                }
            }
            Some(RawPubkey::Bytes(b)) => {
                if b.is_empty() {
                    Ok(None)
                } else {
                    Pubkey::try_from_slice(&b)
                        .map_err(serde::de::Error::custom)
                        .map(Some)
                }
            }
            None => Ok(None),
        }
    }
}
