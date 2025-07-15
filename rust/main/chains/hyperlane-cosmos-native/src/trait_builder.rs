use std::str::FromStr;

use derive_new::new;
use url::Url;

use hyperlane_core::{
    config::OpSubmissionConfig, ChainCommunicationError, FixedPointNumber, NativeToken,
};

/// Cosmos connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// gRPC urls to connect to
    pub grpc_urls: Vec<Url>,
    /// The RPC url to connect to
    rpc_urls: Vec<Url>,
    /// The chain ID
    chain_id: String,
    /// The human readable address prefix for the chains using bech32.
    bech32_prefix: String,
    /// Canonical Assets Denom
    canonical_asset: String,
    /// The gas price set by the cosmos-sdk validator. Note that this represents the
    /// minimum price set by the validator.
    /// More details here: https://docs.cosmos.network/main/learn/beginner/gas-fees#antehandler
    gas_price: RawCosmosAmount,
    /// The gas multiplier is used to estimate gas cost. The gas limit of the simulated transaction will be multiplied by this modifier.
    gas_multiplier: f64,
    /// The number of bytes used to represent a contract address.
    /// Cosmos address lengths are sometimes less than 32 bytes, so this helps to serialize it in
    /// bech32 with the appropriate length.
    contract_address_bytes: usize,
    /// Operation batching configuration
    pub operation_batch: OpSubmissionConfig,
    /// Native Token
    native_token: NativeToken,
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
    pub amount: FixedPointNumber,
}

impl TryFrom<RawCosmosAmount> for CosmosAmount {
    type Error = ChainCommunicationError;
    fn try_from(raw: RawCosmosAmount) -> Result<Self, ChainCommunicationError> {
        Ok(Self {
            denom: raw.denom,
            amount: FixedPointNumber::from_str(&raw.amount)?,
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
    /// Get the RPC urls
    pub fn get_rpc_urls(&self) -> Vec<Url> {
        self.rpc_urls.clone()
    }

    /// Get the chain ID
    pub fn get_chain_id(&self) -> String {
        self.chain_id.clone()
    }

    /// Get the bech32 prefix
    pub fn get_bech32_prefix(&self) -> String {
        self.bech32_prefix.clone()
    }

    /// Get the asset
    pub fn get_canonical_asset(&self) -> String {
        self.canonical_asset.clone()
    }

    /// Get the minimum gas price
    pub fn get_minimum_gas_price(&self) -> RawCosmosAmount {
        self.gas_price.clone()
    }

    /// Get the native token
    pub fn get_native_token(&self) -> &NativeToken {
        &self.native_token
    }

    /// Get the number of bytes used to represent a contract address
    pub fn get_contract_address_bytes(&self) -> usize {
        self.contract_address_bytes
    }

    /// Get gRPC urls
    pub fn get_grpc_urls(&self) -> Vec<Url> {
        self.grpc_urls.clone()
    }

    /// Returns the gas multiplier from the config. Used to estimate txn costs more reliable
    pub fn get_gas_multiplier(&self) -> f64 {
        self.gas_multiplier
    }

    /// Create a new connection configuration
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        rpc_urls: Vec<Url>,
        grpc_urls: Vec<Url>,
        chain_id: String,
        bech32_prefix: String,
        canonical_asset: String,
        minimum_gas_price: RawCosmosAmount,
        gas_multiplier: f64,
        contract_address_bytes: usize,
        operation_batch: OpSubmissionConfig,
        native_token: NativeToken,
    ) -> Self {
        Self {
            grpc_urls,
            rpc_urls,
            chain_id,
            bech32_prefix,
            canonical_asset,
            gas_price: minimum_gas_price,
            contract_address_bytes,
            operation_batch,
            native_token,
            gas_multiplier,
        }
    }
}
