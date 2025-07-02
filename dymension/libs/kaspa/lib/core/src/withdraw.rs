use bytes::Bytes;
use eyre::Error as EyreError;
use hyperlane_core::HyperlaneMessage;
use kaspa_wallet_pskt::prelude::Bundle;
use serde::{Deserialize, Serialize};

/// WithdrawFXG resrents is sequence of PSKT transactions for batch processing and transport as
/// a single serialized payload. Bundle has mulpible PSKT. Each PSKT is associated with
/// some HL messages.
///
/// PSKT inside the bundle and its HL messages should live on respective indices, i.e.,
/// Bundle[0] = PSKT1, messages[0] = {M1, M2} <=> PSKT1 covers M1 and M2.
///
///      Bundle
///        /\
///       /  \
///      /    \
///  PSKT1    PSKT2
///    /\       /\
///   /  \     /  \
///  /    \   /    \
/// M1    M2 M3    M4
#[derive(Debug, Serialize, Deserialize)]
pub struct WithdrawFXG {
    pub bundle: Bundle,
    pub messages: Vec<Vec<HyperlaneMessage>>,
}

impl WithdrawFXG {
    pub fn new(bundle: Bundle, messages: Vec<Vec<HyperlaneMessage>>) -> Self {
        Self { bundle, messages }
    }

    pub fn default() -> Self {
        Self {
            bundle: Bundle::new(),
            messages: vec![],
        }
    }
}

impl TryFrom<Bytes> for WithdrawFXG {
    type Error = EyreError;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        bincode::deserialize(&bytes).map_err(|e| {
            eyre::Report::new(e).wrap_err("Failed to deserialize WithdrawFXG from bytes")
        })
    }
}

impl TryFrom<&WithdrawFXG> for Bytes {
    type Error = EyreError;

    fn try_from(x: &WithdrawFXG) -> Result<Self, Self::Error> {
        Ok(Bytes::from(bincode::serialize(x).map_err(|e| {
            eyre::Report::new(e).wrap_err("Failed to serialize WithdrawFXG into bytes")
        })?))
    }
}
