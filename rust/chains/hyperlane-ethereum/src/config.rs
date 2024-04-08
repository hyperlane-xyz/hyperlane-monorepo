use hyperlane_core::U256;
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
}

/// Ethereum transaction overrides.
#[derive(Debug, Clone, Default)]
pub struct TransactionOverrides {
    /// Gas price to use for transactions, in wei.
    /// If specified, non-1559 transactions will be used with this gas price.
    pub gas_price: Option<U256>,
    /// Gas limit to use for transactions.
    /// If specified, all transactions will use this gas limit.
    pub gas_limit: Option<U256>,
    /// Max fee per gas to use for EIP-1559 transactions.
    pub max_fee_per_gas: Option<U256>,
    /// Max priority fee per gas to use for EIP-1559 transactions.
    pub max_priority_fee_per_gas: Option<U256>,
}
