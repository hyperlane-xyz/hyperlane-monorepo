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
    /// Connection configuration
    pub connection: RpcConnectionConf,
    /// Chain ID
    pub transaction_overrides: Option<TransactionOverrides>,
}

#[derive(Debug, Clone)]
pub struct TransactionOverrides {
    gas_price: Option<U256>,
    gas_limit: Option<U256>,
}
