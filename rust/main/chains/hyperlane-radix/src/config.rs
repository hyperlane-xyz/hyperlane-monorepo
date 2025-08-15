use std::{collections::HashMap, str::FromStr};

use scrypto::network::NetworkDefinition;
use url::Url;

/// Radix connection config
#[derive(Clone, Debug)]
pub struct ConnectionConf {
    /// Core API endpoint
    pub core: Url,
    /// Gateway API endpoint
    pub gateway: Url,
    /// Network definitions
    pub network: NetworkDefinition,
    /// Core Headers
    pub core_header: HashMap<String, String>,
    /// Gateway Headers
    pub gateway_header: HashMap<String, String>,
}

impl ConnectionConf {
    /// Returns a new Connection Config
    pub fn new(
        core: Url,
        gateway: Url,
        network: String,
        core_header: HashMap<String, String>,
        gateway_header: HashMap<String, String>,
    ) -> Self {
        let network = NetworkDefinition::from_str(&network).unwrap_or(NetworkDefinition::mainnet());
        Self {
            core,
            core_header,
            gateway,
            gateway_header,
            network,
        }
    }
}
