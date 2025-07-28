/* For e2e tests and testing only */

use api_rs::apis::configuration;
use kaspa_addresses::{Prefix, Version};
use kaspa_consensus_core::network::{NetworkId, NetworkType};

pub const NETWORK: NetworkType = NetworkType::Testnet;
pub const NETWORK_ID: NetworkId = NetworkId::with_suffix(NETWORK, 10);
pub const ADDRESS_PREFIX: Prefix = Prefix::Testnet;
pub const ADDRESS_VERSION: Version = Version::PubKey;
pub const URL: &str = "localhost:17210"; // local node wrpc to testnet10

// There is a tx mass penalty for creating UTXO less than 0.2 KAS
pub const DEPOSIT_AMOUNT: u64 = 20_000_001;

// How much relayer spends to deliver the tx to the network
pub const RELAYER_NETWORK_FEE: u64 = 5000;

// TODO: remove
pub const ESCROW_ADDRESS: &str =
    "kaspatest:qzwyrgapjnhtjqkxdrmp7fpm3yddw296v2ajv9nmgmw5k3z0r38guevxyk7j0";

pub fn get_tn10_config() -> configuration::Configuration {
    configuration::Configuration {
        base_path: "https://api-tn10.kaspa.org".to_string(),
        user_agent: Some("OpenAPI-Generator/a6a9569/rust".to_owned()),
        client: reqwest_middleware::ClientBuilder::new(reqwest::Client::new()).build(),
        basic_auth: None,
        oauth_access_token: None,
        bearer_access_token: None,
        api_key: None,
    }
}
