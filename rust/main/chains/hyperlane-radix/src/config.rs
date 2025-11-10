use std::str::FromStr;

use scrypto::network::NetworkDefinition;
use url::Url;

/// Radix connection config
#[derive(Clone, Debug)]
pub struct ConnectionConf {
    /// Core API endpoint
    pub core: Vec<Url>,
    /// Gateway API endpoint
    pub gateway: Vec<Url>,
    /// Network definitions
    pub network: NetworkDefinition,
}

impl ConnectionConf {
    /// Returns a new Connection Config
    pub fn new(core: Vec<Url>, gateway: Vec<Url>, network_name: String) -> Self {
        let network = match network_name.as_str() {
            "localnet" => NetworkDefinition::localnet(),
            _ => NetworkDefinition::from_str(&network_name).unwrap_or(NetworkDefinition::mainnet()),
        };

        Self {
            core,
            gateway,
            network,
        }
    }
}
