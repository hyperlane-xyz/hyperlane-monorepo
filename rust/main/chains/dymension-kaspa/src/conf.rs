use std::str::FromStr;

use derive_new::new;
use url::Url;

use hyperlane_core::{
    config::OpSubmissionConfig, ChainCommunicationError, FixedPointNumber, NativeToken,
};

/// Kaspa connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    pub kaspa_rest_url: Url,
    pub escrow_address: String,
    pub validator_hosts: Vec<String>,
}

impl ConnectionConf {
    /// Create a new connection configuration
    #[allow(clippy::too_many_arguments)]
    pub fn new(kaspa_rest_url: Url, escrow_address: String, validator_hosts: Vec<Url>) -> Self {
        Self {
            kaspa_rest_url,
            escrow_address,
            validator_hosts,
        }
    }
}

/// Untyped kaspa amount
#[derive(serde::Serialize, serde::Deserialize, new, Clone, Debug)]
pub struct RawKaspaAmount {
    /// Coin denom (e.g. `untrn`)
    pub denom: String,
    /// Amount in the given denom
    pub amount: String,
}

/// Typed kaspa amount
#[derive(Clone, Debug)]
pub struct KaspaAmount {
    /// Coin denom (e.g. `untrn`)
    pub denom: String,
    /// Amount in the given denom
    pub amount: FixedPointNumber,
}

impl TryFrom<RawKaspaAmount> for KaspaAmount {
    type Error = ChainCommunicationError;
    fn try_from(raw: RawKaspaAmount) -> Result<Self, ChainCommunicationError> {
        Ok(Self {
            denom: raw.denom,
            amount: FixedPointNumber::from_str(&raw.amount)?,
        })
    }
}

/// An error type when parsing a connection configuration.
#[derive(thiserror::Error, Debug)]
pub enum ConnectionConfError {}
