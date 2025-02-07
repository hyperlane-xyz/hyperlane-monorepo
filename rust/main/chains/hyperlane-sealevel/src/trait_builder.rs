use hyperlane_core::{config::OperationBatchConfig, ChainCommunicationError, NativeToken};
use serde::Serialize;
use url::Url;

use crate::{
    priority_fee::{ConstantPriorityFeeOracle, HeliusPriorityFeeOracle, PriorityFeeOracle},
    tx_submitter::{JitoTransactionSubmitter, RpcTransactionSubmitter, TransactionSubmitter},
};

/// Sealevel connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// Fully qualified string to connect to
    pub url: Url,
    /// Operation batching configuration
    pub operation_batch: OperationBatchConfig,
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

/// Configuration for the transaction submitter
#[derive(Debug, Clone)]
pub enum TransactionSubmitterConfig {
    /// Use the RPC transaction submitter
    Rpc {
        /// The URL to use. If not provided, a default RPC URL will be used
        url: Option<String>,
    },
    /// Use the Jito transaction submitter
    Jito {
        /// The URL to use. If not provided, a default Jito URL will be used
        url: Option<String>,
    },
}

impl Default for TransactionSubmitterConfig {
    fn default() -> Self {
        TransactionSubmitterConfig::Rpc { url: None }
    }
}

impl TransactionSubmitterConfig {
    /// Create a new transaction submitter from the configuration
    pub fn create_submitter(&self, default_rpc_url: String) -> Box<dyn TransactionSubmitter> {
        match self {
            TransactionSubmitterConfig::Rpc { url } => Box::new(RpcTransactionSubmitter::new(
                url.clone().unwrap_or(default_rpc_url),
            )),
            TransactionSubmitterConfig::Jito { url } => {
                // Default to a bundle-only URL (i.e. revert protected)
                Box::new(JitoTransactionSubmitter::new(url.clone().unwrap_or_else(
                    || {
                        "https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true"
                            .to_string()
                    },
                )))
            }
        }
    }
}

#[derive(thiserror::Error, Debug)]
#[error(transparent)]
struct SealevelNewConnectionError(#[from] anyhow::Error);

impl From<SealevelNewConnectionError> for ChainCommunicationError {
    fn from(err: SealevelNewConnectionError) -> Self {
        ChainCommunicationError::from_other(err)
    }
}
