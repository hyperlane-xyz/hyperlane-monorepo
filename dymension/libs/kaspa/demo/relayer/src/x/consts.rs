use kaspa_addresses::{Prefix, Version};
use kaspa_consensus_core::network::{NetworkId, NetworkType};

pub const NETWORK: NetworkType = NetworkType::Testnet;
pub const NETWORK_ID: NetworkId = NetworkId::with_suffix(NETWORK, 10);
pub const ADDRESS_PREFIX: Prefix = Prefix::Testnet;
pub const ADDRESS_VERSION: Version = Version::PubKey;
pub const URL: &str = "localhost:17210"; // local node wrpc to testnet10

// There is a tx mass penalty for creating UTXO less than 0.2 KAS
pub const DEPOSIT_AMOUNT: u64 = 100_000_000;

// How much relayer spends to deliver the tx to the network
pub const RELAYER_NETWORK_FEE: u64 = 5000;
