pub use hyperlane_core::config::OpSubmissionConfig;
use url::Url;

/// Sovereign connection configuration.
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// Chain id of sovereign rollup
    pub chain_id: u64,
    /// Operation batching configuration.
    pub op_submission_config: OpSubmissionConfig,
    /// Endpoint address.
    pub url: Url,
}
