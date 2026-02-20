pub use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::NativeToken;
use url::Url;

/// Sovereign connection configuration.
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// Operation batching configuration.
    pub op_submission_config: OpSubmissionConfig,
    /// Endpoint address.
    pub url: Url,
    /// Native token configuration (decimals, denom).
    pub native_token: NativeToken,
}
