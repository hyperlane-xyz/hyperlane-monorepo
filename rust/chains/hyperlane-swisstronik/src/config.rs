use url::Url;

/// Ethereum connection configuration
#[derive(Debug, Clone)]
pub enum ConnectionConf {
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
