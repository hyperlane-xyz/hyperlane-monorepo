use redact::Secret;
use url::Url;

pub(crate) const DEFAULT_ENERGY_MULTIPLIER: f64 = 1.5;

/// Tron connection configuration
#[derive(Clone, Debug)]
pub struct ConnectionConf {
    /// RPC urls
    pub rpc_urls: Secret<Vec<Url>>,
    /// Wallet HTTP API urls (full node)
    pub wallet_urls: Secret<Vec<Url>>,
    /// Wallet Solidity HTTP API urls (solidity node)
    pub wallet_solidity_urls: Secret<Vec<Url>>,
    /// Optional Energy multiplier
    pub energy_multiplier: Option<f64>,
}

impl ConnectionConf {
    /// Construct a connection without exposing URLs in diagnostics.
    pub fn new(
        rpc_urls: Vec<Url>,
        wallet_urls: Vec<Url>,
        wallet_solidity_urls: Vec<Url>,
        energy_multiplier: Option<f64>,
    ) -> Self {
        Self {
            rpc_urls: Secret::new(rpc_urls),
            wallet_urls: Secret::new(wallet_urls),
            wallet_solidity_urls: Secret::new(wallet_solidity_urls),
            energy_multiplier,
        }
    }
}
