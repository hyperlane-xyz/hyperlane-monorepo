pub use hyperlane_core::config::OperationBatchConfig;
use url::Url;

/// Sovereign connection configuration.
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// Chain id of sovereign rollup
    pub chain_id: u64,
    /// Operation batching configuration.
    pub operation_batch: OperationBatchConfig,
    /// Endpoint address.
    pub url: Url,
}
