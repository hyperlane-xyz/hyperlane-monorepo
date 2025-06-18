use ethers::providers::Middleware;
use ethers_core::types::{BlockId, BlockNumber};
use url::Url;

use hyperlane_core::{
    config::OpSubmissionConfig, ChainCommunicationError, ChainResult, ReorgPeriod, U256,
};

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

impl Default for RpcConnectionConf {
    fn default() -> Self {
        RpcConnectionConf::HttpFallback { urls: vec![] }
    }
}

/// Ethereum connection configuration
#[derive(Clone, Debug, Default)]
pub struct ConnectionConf {
    /// RPC connection configuration
    pub rpc_connection: RpcConnectionConf,
    /// Transaction overrides to use when sending transactions.
    pub transaction_overrides: TransactionOverrides,
    /// Operation batching configuration
    pub op_submission_config: OpSubmissionConfig,
}

impl ConnectionConf {
    /// Returns the RPC urls for this connection configuration
    pub fn rpc_urls(&self) -> Vec<Url> {
        use RpcConnectionConf::{Http, HttpFallback, HttpQuorum, Ws};

        match &self.rpc_connection {
            HttpQuorum { urls } | HttpFallback { urls } => urls.clone(),
            Http { url } => vec![url.clone()],
            Ws { url: _ } => panic!("Websocket connection is not supported"),
        }
    }
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

    /// Min gas price to use for Legacy transactions, in wei.
    pub min_gas_price: Option<U256>,
    /// Min fee per gas to use for EIP-1559 transactions.
    pub min_fee_per_gas: Option<U256>,
    /// Min priority fee per gas to use for EIP-1559 transactions.
    pub min_priority_fee_per_gas: Option<U256>,

    /// Gas limit multiplier denominator to use for transactions, eg 110
    pub gas_limit_multiplier_denominator: Option<U256>,
    /// Gas limit multiplier numerator to use for transactions, eg 100
    pub gas_limit_multiplier_numerator: Option<U256>,

    /// Gas price multiplier denominator to use for transactions, eg 110
    pub gas_price_multiplier_denominator: Option<U256>,
    /// Gas price multiplier numerator to use for transactions, eg 100
    pub gas_price_multiplier_numerator: Option<U256>,

    /// Gas price cap, in wei.
    pub gas_price_cap: Option<U256>,
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
    type Error = ChainCommunicationError;

    fn try_from(value: &ReorgPeriod) -> Result<Self, Self::Error> {
        match value {
            ReorgPeriod::None => Ok(EthereumReorgPeriod::Blocks(0)),
            ReorgPeriod::Blocks(blocks) => Ok(EthereumReorgPeriod::Blocks(blocks.get())),
            ReorgPeriod::Tag(tag) => {
                let tag = match tag.as_str() {
                    "latest" => BlockNumber::Latest,
                    "finalized" => BlockNumber::Finalized,
                    "safe" => BlockNumber::Safe,
                    "earliest" => BlockNumber::Earliest,
                    "pending" => BlockNumber::Pending,
                    _ => return Err(ChainCommunicationError::InvalidReorgPeriod(value.clone())),
                };
                Ok(EthereumReorgPeriod::Tag(tag.into()))
            }
        }
    }
}

impl EthereumReorgPeriod {
    /// Converts the reorg period into a block id
    pub async fn into_block_id<M: Middleware + 'static>(
        &self,
        provider: &M,
    ) -> ChainResult<BlockId> {
        let block_id = match self {
            EthereumReorgPeriod::Blocks(_) => {
                (crate::get_finalized_block_number(provider, self).await? as u64).into()
            }
            // no need to fetch the block number for the `tag`
            EthereumReorgPeriod::Tag(tag) => *tag,
        };
        Ok(block_id)
    }
}

#[cfg(test)]
mod tests;
