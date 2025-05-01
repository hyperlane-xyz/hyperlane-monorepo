use hyperlane_core::{config::OpSubmissionConfig, ChainCommunicationError, NativeToken};
use serde::Serialize;
use url::Url;

use crate::{
    priority_fee::{ConstantPriorityFeeOracle, HeliusPriorityFeeOracle, PriorityFeeOracle},
    tx_submitter::config::TransactionSubmitterConfig,
};

/// Sealevel connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// A list of urls to connect to
    pub urls: Vec<Url>,
    /// Operation batching configuration
    pub op_submission_config: OpSubmissionConfig,
    /// Native token and its denomination
    pub native_token: NativeToken,
    /// Priority fee oracle configuration
    pub priority_fee_oracle: PriorityFeeOracleConfig,
    /// Transaction submitter configuration
    pub transaction_submitter: TransactionSubmitterConfig,
}

/// An error type when parsing a connection configuration.
#[derive(thiserror::Error, Debug)]
pub enum ConnectionConfError {
    /// Missing `url` for connection configuration
    #[error("Missing `url` for connection configuration")]
    MissingConnectionUrl,
    /// Invalid `url` for connection configuration
    #[error("Invalid `url` for connection configuration: `{0}` ({1})")]
    InvalidConnectionUrl(String, url::ParseError),
}

/// Configuration to of how the priority fee should be determined
#[derive(Debug, Clone)]
pub enum PriorityFeeOracleConfig {
    /// A constant value, in micro lamports
    Constant(u64),
    /// A Helius priority fee oracle
    Helius(HeliusPriorityFeeOracleConfig),
}

impl Default for PriorityFeeOracleConfig {
    fn default() -> Self {
        PriorityFeeOracleConfig::Constant(0)
    }
}

impl PriorityFeeOracleConfig {
    /// Create a new priority fee oracle from the configuration
    pub fn create_oracle(&self) -> Box<dyn PriorityFeeOracle> {
        match self {
            PriorityFeeOracleConfig::Constant(fee) => {
                Box::new(ConstantPriorityFeeOracle::new(*fee))
            }
            PriorityFeeOracleConfig::Helius(config) => {
                Box::new(HeliusPriorityFeeOracle::new(config.clone()))
            }
        }
    }
}

/// Configuration for the Helius priority fee oracle
#[derive(Debug, Clone)]
pub struct HeliusPriorityFeeOracleConfig {
    /// The Helius URL to use
    pub url: Url,
    /// The fee level to use
    pub fee_level: HeliusPriorityFeeLevel,
}

/// The priority fee level to use
#[derive(Debug, Clone, Serialize, Default)]
pub enum HeliusPriorityFeeLevel {
    /// 50th percentile, but a floor of 10k microlamports.
    /// The floor results in a staked Helius connection being used. (https://docs.helius.dev/guides/sending-transactions-on-solana#staked-connections)
    #[default]
    Recommended,
    /// 0th percentile
    Min,
    /// 10th percentile
    Low,
    /// 50th percentile
    Medium,
    /// 75th percentile
    High,
    /// 90th percentile
    VeryHigh,
    /// 100th percentile
    UnsafeMax,
}

#[derive(thiserror::Error, Debug)]
#[error(transparent)]
struct SealevelNewConnectionError(#[from] anyhow::Error);

impl From<SealevelNewConnectionError> for ChainCommunicationError {
    fn from(err: SealevelNewConnectionError) -> Self {
        ChainCommunicationError::from_other(err)
    }
}
