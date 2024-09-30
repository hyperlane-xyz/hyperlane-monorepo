use ethers_core::types::{BlockId, BlockNumber};
use eyre::{eyre, Report};
use hyperlane_core::{config::OperationBatchConfig, ReorgPeriod, U256};
use url::Url;

/// Ethereum RPC connection configuration
#[derive(Debug, Clone)]
pub enum RpcConnectionConf {
    /// An HTTP-only quorum.
    HttpQuorum {
        /// List of urls to connect to
        urls: Vec<Url>,
    },
    /// An HTTP-only fallback set.
    HttpFallback {
        /// List of urls to connect to in order of priority
        urls: Vec<Url>,
    },
    /// HTTP connection details
    Http {
        /// Url to connect to
        url: Url,
    },
    /// Websocket connection details
    Ws {
        /// Url to connect to
        url: Url,
    },
}

/// Ethereum connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// RPC connection configuration
    pub rpc_connection: RpcConnectionConf,
    /// Transaction overrides to use when sending transactions.
    pub transaction_overrides: TransactionOverrides,
    /// Operation batching configuration
    pub operation_batch: OperationBatchConfig,
}

/// Ethereum transaction overrides.
#[derive(Debug, Clone, Default)]
pub struct TransactionOverrides {
    /// Gas price to use for transactions, in wei.
    /// If specified, non-1559 transactions will be used with this gas price.
    pub gas_price: Option<U256>,
    /// Gas limit to use for transactions.
    /// If unspecified, the gas limit will be estimated.
    /// If specified, transactions will use `max(estimated_gas, gas_limit)`
    pub gas_limit: Option<U256>,
    /// Max fee per gas to use for EIP-1559 transactions.
    pub max_fee_per_gas: Option<U256>,
    /// Max priority fee per gas to use for EIP-1559 transactions.
    pub max_priority_fee_per_gas: Option<U256>,
}

/// Ethereum reorg period
#[derive(Copy, Clone, Debug)]
pub enum EthereumReorgPeriod {
    /// Number of blocks
    Blocks(u32),
    /// A block tag
    Tag(BlockId),
}

impl TryFrom<&ReorgPeriod> for EthereumReorgPeriod {
    type Error = Report;

    fn try_from(value: &ReorgPeriod) -> Result<Self, Self::Error> {
        match value {
            ReorgPeriod::Blocks(blocks) => Ok(EthereumReorgPeriod::Blocks(*blocks)),
            ReorgPeriod::Tag(tag) => {
                let tag = match tag.as_str() {
                    "latest" => BlockNumber::Latest,
                    "finalized" => BlockNumber::Finalized,
                    "safe" => BlockNumber::Safe,
                    "earliest" => BlockNumber::Earliest,
                    "pending" => BlockNumber::Pending,
                    _ => return Err(eyre!("Invalid Ethereum reorg period")),
                };
                Ok(EthereumReorgPeriod::Tag(tag.into()))
            }
        }
    }
}
