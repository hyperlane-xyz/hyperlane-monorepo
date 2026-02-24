use derive_new::new;
use url::Url;

pub(crate) const DEFAULT_ENERGY_MULTIPLIER: f64 = 1.5;

/// Tron connection configuration
#[derive(Clone, Debug, new)]
pub struct ConnectionConf {
    /// RPC urls
    pub rpc_urls: Vec<Url>,
    /// gRPC urls
    pub grpc_urls: Vec<Url>,
    /// Solidity gRPC urls
    pub solidity_grpc_urls: Vec<Url>,
    /// Optional Energy multiplier
    pub energy_multiplier: Option<f64>,
}
