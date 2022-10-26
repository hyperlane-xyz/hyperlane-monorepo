#![allow(missing_docs)]

use std::str::FromStr;

use eyre::Result;
use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use serde::{Deserialize, Serialize};
use strum::{EnumIter, EnumString};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Address(pub bytes::Bytes);

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Balance(pub num::BigInt);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractLocator {
    pub chain_name: String,
    pub domain: u32,
    pub address: Address,
}
impl std::fmt::Display for ContractLocator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}[@{}]+contract:0x{:x}",
            self.chain_name, self.domain, self.address.0
        )
    }
}

#[async_trait::async_trait]
pub trait Chain {
    /// Query the balance on a chain
    async fn query_balance(&self, addr: Address) -> Result<Balance>;
}

impl From<Address> for ethers::types::H160 {
    fn from(addr: Address) -> Self {
        ethers::types::H160::from_slice(addr.0.as_ref())
    }
}

impl From<ethers::types::H160> for Address {
    fn from(addr: ethers::types::H160) -> Self {
        Address(bytes::Bytes::from(addr.as_bytes().to_owned()))
    }
}

impl From<&'_ Address> for ethers::types::H160 {
    fn from(addr: &Address) -> Self {
        ethers::types::H160::from_slice(addr.0.as_ref())
    }
}

/// All domains supported by Abacus.
#[derive(FromPrimitive, EnumString, strum::Display, EnumIter, PartialEq, Eq, Debug)]
#[strum(serialize_all = "lowercase")]
pub enum AbacusDomain {
    /// Ethereum mainnet domain ID, decimal ID 6648936
    Ethereum = 0x657468,
    /// Ethereum testnet Goerli domain ID
    Goerli = 5,
    /// Ethereum testnet Kovan domain ID
    Kovan = 3000,

    /// Polygon mainnet domain ID, decimal ID 1886350457
    Polygon = 0x706f6c79,
    /// Polygon testnet Mumbai domain ID
    Mumbai = 80001,

    /// Avalanche mainnet domain ID, decimal ID 1635148152
    Avalanche = 0x61766178,
    /// Avalanche testnet Fuji domain ID
    Fuji = 43113,

    /// Arbitrum mainnet domain ID, decimal ID 6386274
    Arbitrum = 0x617262,
    /// Arbitrum testnet ArbitrumRinkeby domain ID, decimal ID 1634872690
    ArbitrumRinkeby = 0x61722d72,
    ArbitrumGoerli = 421613,

    /// Optimism mainnet domain ID, decimal ID 28528
    Optimism = 0x6f70,
    /// Optimism testnet OptimismKovan domain ID, decimal ID 1869622635
    OptimismKovan = 0x6f702d6b,
    OptimismGoerli = 420,

    /// BSC mainnet domain ID, decimal ID 6452067
    #[strum(serialize = "bsc")]
    BinanceSmartChain = 0x627363,
    /// BSC testnet, decimal ID 1651715444
    #[strum(serialize = "bsctestnet")]
    BinanceSmartChainTestnet = 0x62732d74,

    /// Celo domain ID, decimal ID 1667591279
    Celo = 0x63656c6f,
    /// Celo testnet Alfajores domain ID
    Alfajores = 1000,

    /// Moonbeam testnet MoonbaseAlpha domain ID, decimal ID 1836002657
    MoonbaseAlpha = 0x6d6f2d61,
    /// Moonbeam domain ID, decimal ID 1836002669
    Moonbeam = 0x6d6f2d6d,

    Zksync2Testnet = 280,

    // -- Local test chains --
    /// Test1 local chain
    Test1 = 13371,
    /// Test2 local chain
    Test2 = 13372,
    /// Test3 local chain
    Test3 = 13373,
}

impl From<AbacusDomain> for u32 {
    fn from(domain: AbacusDomain) -> Self {
        domain as u32
    }
}

impl TryFrom<u32> for AbacusDomain {
    type Error = eyre::Error;

    fn try_from(domain_id: u32) -> Result<Self, Self::Error> {
        FromPrimitive::from_u32(domain_id)
            .ok_or_else(|| eyre::eyre!("Unknown domain ID {domain_id}"))
    }
}

/// Types of Abacus domains.
pub enum AbacusDomainType {
    /// A mainnet.
    Mainnet,
    /// A testnet.
    Testnet,
    /// A local chain for testing (i.e. Hardhat node).
    LocalTestChain,
}

impl AbacusDomain {
    pub fn domain_type(&self) -> AbacusDomainType {
        match self {
            AbacusDomain::Ethereum => AbacusDomainType::Mainnet,
            AbacusDomain::Goerli => AbacusDomainType::Testnet,
            AbacusDomain::Kovan => AbacusDomainType::Testnet,

            AbacusDomain::Polygon => AbacusDomainType::Mainnet,
            AbacusDomain::Mumbai => AbacusDomainType::Testnet,

            AbacusDomain::Avalanche => AbacusDomainType::Mainnet,
            AbacusDomain::Fuji => AbacusDomainType::Testnet,

            AbacusDomain::Arbitrum => AbacusDomainType::Mainnet,
            AbacusDomain::ArbitrumRinkeby => AbacusDomainType::Testnet,
            AbacusDomain::ArbitrumGoerli => AbacusDomainType::Testnet,

            AbacusDomain::Optimism => AbacusDomainType::Mainnet,
            AbacusDomain::OptimismKovan => AbacusDomainType::Testnet,
            AbacusDomain::OptimismGoerli => AbacusDomainType::Testnet,

            AbacusDomain::BinanceSmartChain => AbacusDomainType::Mainnet,
            AbacusDomain::BinanceSmartChainTestnet => AbacusDomainType::Testnet,

            AbacusDomain::Celo => AbacusDomainType::Mainnet,
            AbacusDomain::Alfajores => AbacusDomainType::Testnet,

            AbacusDomain::MoonbaseAlpha => AbacusDomainType::Testnet,
            AbacusDomain::Moonbeam => AbacusDomainType::Mainnet,

            AbacusDomain::Zksync2Testnet => AbacusDomainType::Testnet,

            AbacusDomain::Test1 => AbacusDomainType::LocalTestChain,
            AbacusDomain::Test2 => AbacusDomainType::LocalTestChain,
            AbacusDomain::Test3 => AbacusDomainType::LocalTestChain,
        }
    }
}

/// Gets the name of the chain from a domain id.
/// Returns None if the domain ID is not recognized.
pub fn name_from_domain_id(domain_id: u32) -> Option<String> {
    AbacusDomain::try_from(domain_id)
        .ok()
        .map(|domain| domain.to_string())
}

/// Gets the domain ID of the chain its name.
/// Returns None if the chain name is not recognized.
pub fn domain_id_from_name(name: &'static str) -> Option<u32> {
    AbacusDomain::from_str(name)
        .ok()
        .map(|domain| domain.into())
}

#[cfg(test)]
mod tests {
    use abacus_base::Settings;
    use config::{Config, File, FileFormat};
    use num_traits::identities::Zero;
    use std::collections::BTreeSet;
    use std::fs::read_to_string;
    use std::path::Path;
    use std::str::FromStr;
    use walkdir::WalkDir;

    use crate::{domain_id_from_name, name_from_domain_id, AbacusDomain};

    /// Relative path to the `abacus-monorepo/rust/config/`
    /// directory, which is where the agent's config files
    /// currently live.
    const AGENT_CONFIG_PATH_ROOT: &str = "../config";

    /// We will not include any file paths of config/settings files
    /// in the test suite if *any* substring of the file path matches
    /// against one of the strings included in the blacklist below.
    /// This is to ensure that e.g. when a backwards-incompatible
    /// change is made in config file format, and agents can't parse
    /// them anymore, we don't fail the test. (E.g. agents cannot
    /// currently parse the older files in `config/dev/` or
    /// `config/testnet`.
    const BLACKLISTED_DIRS: &[&str] = &[
        // Ignore only-local names of fake chains used by
        // e.g. test suites.
        "test/test1_config.json",
        "test/test2_config.json",
        "test/test3_config.json",
    ];

    fn is_blacklisted(path: &Path) -> bool {
        BLACKLISTED_DIRS
            .iter()
            .any(|x| path.to_str().unwrap().contains(x))
    }

    #[derive(Clone, Debug, Ord, PartialEq, PartialOrd, Eq, Hash)]
    struct ChainCoordinate {
        name: String,
        domain: u32,
    }

    fn config_paths(root: &Path) -> Vec<String> {
        WalkDir::new(root)
            .min_depth(2)
            .into_iter()
            .filter_map(|x| x.ok())
            .map(|x| x.into_path())
            .filter(|x| !is_blacklisted(x))
            .map(|x| x.into_os_string())
            .filter_map(|x| x.into_string().ok())
            .collect()
    }

    /// Provides a vector of parsed `abacus_base::Settings` objects
    /// built from all of the version-controlled agent configuration files.
    /// This is purely a utility to allow us to test a handful of critical
    /// properties related to those configs and shouldn't be used outside
    /// of a test env. This test simply tries to do some sanity checks
    /// against the integrity of that data.
    fn abacus_settings() -> Vec<Settings> {
        let root = Path::new(AGENT_CONFIG_PATH_ROOT);
        let paths = config_paths(root);
        let files: Vec<String> = paths
            .iter()
            .filter(|n| {
                // Special config with different rules, with
                // https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/1134
                // we will remove this weird case
                !n.contains("scraper_config")
            })
            .filter_map(|x| read_to_string(x).ok())
            .collect();
        paths
            .iter()
            .zip(files.iter())
            .map(|(p, f)| {
                Config::builder()
                    .add_source(File::from_str(f.as_str(), FileFormat::Json))
                    .build()
                    .unwrap()
                    .try_deserialize()
                    .unwrap_or_else(|e| {
                        panic!("!cfg({}): {:?}: {}", p, e, f);
                    })
            })
            .collect()
    }

    fn outbox_chain_names() -> BTreeSet<String> {
        abacus_settings()
            .iter()
            .map(|x| x.outbox.name.clone())
            .collect()
    }

    fn inbox_chain_names() -> BTreeSet<String> {
        abacus_settings()
            .iter()
            .flat_map(|x: &Settings| x.inboxes.iter().map(|(k, _)| String::from(k)))
            .collect()
    }

    fn outbox_name_domain_coords() -> BTreeSet<ChainCoordinate> {
        abacus_settings()
            .iter()
            .map(|x| ChainCoordinate {
                name: x.outbox.name.clone(),
                domain: x.outbox.domain.parse().unwrap(),
            })
            .collect()
    }

    fn inbox_name_domain_records() -> BTreeSet<ChainCoordinate> {
        abacus_settings()
            .iter()
            .flat_map(|x: &Settings| {
                x.inboxes.iter().map(|(_, v)| ChainCoordinate {
                    name: v.name.clone(),
                    domain: v.domain.parse().unwrap(),
                })
            })
            .collect()
    }

    #[test]
    fn agent_json_config_consistency_checks() {
        // Inbox/outbox and chain-presence equality
        // (sanity checks that we have a complete list of
        // relevant chains).
        let inbox_chains = inbox_chain_names();
        let outbox_chains = outbox_chain_names();
        assert!(inbox_chains.symmetric_difference(&outbox_chains).count() == usize::zero());
        assert_eq!(&inbox_chains.len(), &outbox_chains.len());

        // Verify that the the outbox-associative chain-name
        // and domain-number records agree with the
        // inbox-associative chain-name and domain-number
        // records, since our configuration data is /not/
        // normalized and could drift out of sync.
        let inbox_coords = inbox_name_domain_records();
        let outbox_coords = outbox_name_domain_coords();
        assert!(inbox_coords.symmetric_difference(&outbox_coords).count() == usize::zero());
        assert_eq!(&inbox_coords.len(), &outbox_coords.len());

        // TODO(webbhorn): Also verify with this functionality
        // we have entries for all of the Gelato contract
        // addresses we need hardcoded in the binary for now.

        // Verify that the hard-coded, macro-maintained
        // mapping in `abacus-core/src/chain.rs` named
        // by the macro `domain_and_chain` is complete
        // and in agreement with our on-disk json-based
        // configuration data.

        for ChainCoordinate { name, domain } in inbox_coords.iter().chain(outbox_coords.iter()) {
            assert_eq!(
                AbacusDomain::try_from(domain.to_owned())
                    .unwrap()
                    .to_string(),
                name.to_owned()
            );
            assert_eq!(
                u32::from(AbacusDomain::from_str(name).unwrap()),
                domain.to_owned()
            );
        }
    }

    #[test]
    fn domain_strings() {
        assert_eq!(
            AbacusDomain::from_str("ethereum").unwrap(),
            AbacusDomain::Ethereum,
        );
        assert_eq!(AbacusDomain::Ethereum.to_string(), "ethereum".to_string(),);
    }

    #[test]
    fn domain_ids() {
        assert_eq!(
            AbacusDomain::try_from(0x657468u32).unwrap(),
            AbacusDomain::Ethereum,
        );

        assert_eq!(u32::from(AbacusDomain::Ethereum), 0x657468u32,);
    }

    #[test]
    fn test_name_from_domain_id() {
        assert_eq!(name_from_domain_id(0x657468u32), Some("ethereum".into()),);

        assert_eq!(name_from_domain_id(0xf00u32), None,);
    }

    #[test]
    fn test_domain_id_from_name() {
        assert_eq!(domain_id_from_name("ethereum"), Some(0x657468u32),);

        assert_eq!(domain_id_from_name("foo"), None,);
    }
}
