use derive_new::new;
use url::Url;

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
