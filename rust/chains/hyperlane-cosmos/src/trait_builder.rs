use derive_new::new;
use hyperlane_core::{ChainCommunicationError, U256};

use crate::HyperlaneCosmosError;

/// Cosmos connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// The GRPC url to connect to
    grpc_url: String,
    /// The RPC url to connect to
    rpc_url: String,
    /// The chain ID
    chain_id: String,
    /// The prefix for the account address
    prefix: String,
    /// Canoncial Assets Denom
    canonical_asset: String,
    /// The minimum gas price set by the cosmos-sdk validator
    minimum_gas_price: RawCosmosAmount,
}

/// Untyped cosmos amount
#[derive(serde::Serialize, serde::Deserialize, new, Clone, Debug)]
pub struct RawCosmosAmount {
    /// Coin denom (e.g. `untrn`)
    pub denom: String,
    /// Amount in the given denom
    pub amount: String,
}

/// Typed cosmos amount
#[derive(Clone, Debug)]
pub struct CosmosAmount {
    /// Coin denom (e.g. `untrn`)
    pub denom: String,
    /// Amount in the given denom
    pub amount: U256,
}

impl TryFrom<RawCosmosAmount> for CosmosAmount {
    type Error = ChainCommunicationError;
    fn try_from(raw: RawCosmosAmount) -> Result<Self, ChainCommunicationError> {
        // Converts to U256 by always rounding up.

        // Remove the decimal part
        let integer = raw
            .amount
            .split('.')
            .next()
            .ok_or(HyperlaneCosmosError::NumStrParse)?;
        let amount = U256::from_dec_str(integer)?;
        Ok(Self {
            denom: raw.denom,
            // Add one to conservatively estimate the gas cost in case there was a decimal part
            amount: amount + 1,
        })
    }
}

/// An error type when parsing a connection configuration.
#[derive(thiserror::Error, Debug)]
pub enum ConnectionConfError {
    /// Missing `rpc_url` for connection configuration
    #[error("Missing `rpc_url` for connection configuration")]
    MissingConnectionRpcUrl,
    /// Missing `grpc_url` for connection configuration
    #[error("Missing `grpc_url` for connection configuration")]
    MissingConnectionGrpcUrl,
    /// Missing `chainId` for connection configuration
    #[error("Missing `chainId` for connection configuration")]
    MissingChainId,
    /// Missing `prefix` for connection configuration
    #[error("Missing `prefix` for connection configuration")]
    MissingPrefix,
    /// Invalid `url` for connection configuration
    #[error("Invalid `url` for connection configuration: `{0}` ({1})")]
    InvalidConnectionUrl(String, url::ParseError),
}

impl ConnectionConf {
    /// Get the GRPC url
    pub fn get_grpc_url(&self) -> String {
        self.grpc_url.clone()
    }

    /// Get the RPC url
    pub fn get_rpc_url(&self) -> String {
        self.rpc_url.clone()
    }

    /// Get the chain ID
    pub fn get_chain_id(&self) -> String {
        self.chain_id.clone()
    }

    /// Get the prefix
    pub fn get_prefix(&self) -> String {
        self.prefix.clone()
    }

    /// Get the asset
    pub fn get_canonical_asset(&self) -> String {
        self.canonical_asset.clone()
    }

    /// Get the minimum gas price
    pub fn get_minimum_gas_price(&self) -> RawCosmosAmount {
        self.minimum_gas_price.clone()
    }

    /// Create a new connection configuration
    pub fn new(
        grpc_url: String,
        rpc_url: String,
        chain_id: String,
        prefix: String,
        canonical_asset: String,
        minimum_gas_price: RawCosmosAmount,
    ) -> Self {
        Self {
            grpc_url,
            rpc_url,
            chain_id,
            prefix,
            canonical_asset,
            minimum_gas_price,
        }
    }
}
