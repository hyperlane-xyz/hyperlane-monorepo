use bytes::Bytes;
use eyre::Error as EyreError;
use kaspa_wallet_pskt::prelude::Bundle;

pub struct WithdrawFXG {
    // may contain other things, caches, etc
    pub bundle: Bundle,
}

impl WithdrawFXG {
    pub fn new(bundle: Bundle) -> Self {
        Self { bundle }
    }

    pub fn default() -> Self {
        Self {
            bundle: Bundle::new(),
        }
    }
}

impl TryFrom<Bytes> for WithdrawFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        let s = String::from_utf8(bytes.to_vec())?;
        let bundle = Bundle::deserialize(&s)?;
        Ok(WithdrawFXG { bundle })
    }
}

impl TryFrom<&WithdrawFXG> for Bytes {
    type Error = EyreError;
    fn try_from(x: &WithdrawFXG) -> Result<Self, Self::Error> {
        let encoded = x.bundle.serialize()?;
        Ok(encoded.into())
    }
}
