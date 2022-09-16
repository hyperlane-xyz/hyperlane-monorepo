#![allow(missing_docs)]

use std::str::FromStr;

use eyre::Result;
use num_traits::FromPrimitive;
use num_derive::FromPrimitive;
use serde::{Deserialize, Serialize};
use strum::EnumString;

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

/// All mainnet domains supported by Abacus.
#[derive(FromPrimitive, EnumString, strum::Display, PartialEq, Eq, Debug)]
#[strum(serialize_all = "lowercase")]
pub enum AbacusMainnetDomain {
    /// Ethereum domain ID, decimal ID 6648936
    Ethereum = 0x657468,

    /// Polygon domain ID, decimal ID 1886350457
    Polygon = 0x706f6c79,

    /// Avalanche domain ID, decimal ID 1635148152
    Avalanche = 0x61766178,

    /// Arbitrum domain ID, decimal ID 6386274
    Arbitrum = 0x617262,

    /// Optimism domain ID, decimal ID 28528
    Optimism = 0x6f70,

    /// BinanceSmartChain domain ID, decimal ID 6452067
    #[strum(serialize = "bsc")]
    BinanceSmartChain = 0x627363,

    /// Celo domain ID, decimal ID 1667591279
    Celo = 0x63656c6f,
}

impl From<AbacusMainnetDomain> for u32 {
    fn from(domain: AbacusMainnetDomain) -> Self {
        domain as u32
    }
}

impl TryFrom<u32> for AbacusMainnetDomain {
    type Error = eyre::Error;

    fn try_from(domain_id: u32) -> Result<Self, Self::Error> {
        FromPrimitive::from_u32(domain_id)
            .ok_or_else(|| eyre::eyre!("Unknown mainnet domain ID {}", domain_id))
    }
}

/// All testnet domains supported by Abacus.
#[derive(FromPrimitive, EnumString, strum::Display, PartialEq, Eq, Debug)]
#[strum(serialize_all = "lowercase")]
pub enum AbacusTestnetDomain {
    /// Ethereum testnet Goerli domain ID
    Goerli = 5,
    /// Ethereum testnet Kovan domain ID
    Kovan = 3000,

    /// Polygon testnet Mumbai domain ID
    Mumbai = 80001,

    /// Avalanche testnet Fuji domain ID
    Fuji = 43113,

    /// Arbitrum testnet ArbitrumRinkeby domain ID, decimal ID 1634872690
    ArbitrumRinkeby = 0x61722d72,

    /// Optimism testnet OptimismKovan domain ID, decimal ID 1869622635
    OptimismKovan = 0x6f702d6b,

    /// BSC testnet, decimal ID 1651715444
    #[strum(serialize = "bsctestnet")]
    BinanceSmartChainTestnet = 0x62732d74, // decimal 1651715444

    /// Celo testnet Alfajores domain ID
    Alfajores = 1000,

    /// Moonbeam testnet MoonbaseAlpha domain ID, decimal ID 1836002657
    MoonbaseAlpha = 0x6d6f2d61,
}

impl From<AbacusTestnetDomain> for u32 {
    fn from(domain: AbacusTestnetDomain) -> Self {
        domain as u32
    }
}

impl TryFrom<u32> for AbacusTestnetDomain {
    type Error = eyre::Error;

    fn try_from(domain_id: u32) -> Result<Self, Self::Error> {
        FromPrimitive::from_u32(domain_id)
            .ok_or_else(|| eyre::eyre!("Unknown testnet domain ID {}", domain_id))
    }
}

/// Local test chains (i.e. typically local hardhat nodes)
#[derive(FromPrimitive, EnumString, strum::Display, PartialEq, Eq, Debug)]
#[strum(serialize_all = "lowercase")]
pub enum AbacusLocalTestChainDomain {
    /// Test1 local chain
    Test1 = 13371,
    /// Test2 local chain
    Test2 = 13372,
    /// Test3 local chain
    Test3 = 13373,
}

impl From<AbacusLocalTestChainDomain> for u32 {
    fn from(domain: AbacusLocalTestChainDomain) -> Self {
        domain as u32
    }
}

impl TryFrom<u32> for AbacusLocalTestChainDomain {
    type Error = eyre::Error;

    fn try_from(domain_id: u32) -> Result<Self, Self::Error> {
        FromPrimitive::from_u32(domain_id)
            .ok_or_else(|| eyre::eyre!("Unknown local test chain domain ID {}", domain_id))
    }
}

/// All domains supported by Abacus.
#[derive(Debug, PartialEq, Eq)]
pub enum AbacusDomain {
    /// Mainnet domains.
    Mainnet(AbacusMainnetDomain),
    /// Testnet domains.
    Testnet(AbacusTestnetDomain),
    /// Local test domains (i.e. not public blockchains)
    LocalTestChain(AbacusLocalTestChainDomain),
}

impl TryFrom<u32> for AbacusDomain {
    type Error = eyre::Error;

    fn try_from(domain_id: u32) -> Result<Self, Self::Error> {
        if let Ok(mainnet_domain) = AbacusMainnetDomain::try_from(domain_id) {
            Ok(Self::Mainnet(mainnet_domain))
        } else if let Ok(testnet_domain) = AbacusTestnetDomain::try_from(domain_id) {
            Ok(Self::Testnet(testnet_domain))
        } else if let Ok(local_test_chain) = AbacusLocalTestChainDomain::try_from(domain_id) {
            Ok(Self::LocalTestChain(local_test_chain))
        } else {
            Err(eyre::eyre!("Unknown domain ID {}", domain_id))
        }
    }
}

impl From<AbacusDomain> for u32 {
    fn from(domain: AbacusDomain) -> Self {
        match domain {
            AbacusDomain::Mainnet(mainnet_domain) => mainnet_domain.into(),
            AbacusDomain::Testnet(testnet_domain) => testnet_domain.into(),
            AbacusDomain::LocalTestChain(local_test_chain) => local_test_chain.into(),
        }
    }
}

impl ToString for AbacusDomain {
    fn to_string(&self) -> String {
        match self {
            AbacusDomain::Mainnet(mainnet_domain) => mainnet_domain.to_string(),
            AbacusDomain::Testnet(testnet_domain) => testnet_domain.to_string(),
            AbacusDomain::LocalTestChain(local_test_chain) => local_test_chain.to_string(),
        }
    }
}

impl FromStr for AbacusDomain {
    type Err = strum::ParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if let Ok(mainnet_domain) = AbacusMainnetDomain::from_str(s) {
            Ok(Self::Mainnet(mainnet_domain))
        } else if let Ok(testnet_domain) = AbacusTestnetDomain::from_str(s) {
            Ok(Self::Testnet(testnet_domain))
        } else if let Ok(local_test_chain) = AbacusLocalTestChainDomain::from_str(s) {
            Ok(Self::LocalTestChain(local_test_chain))
        } else {
            Err(strum::ParseError::VariantNotFound)
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

    use crate::{
        domain_id_from_name, name_from_domain_id, AbacusDomain, AbacusLocalTestChainDomain,
        AbacusMainnetDomain, AbacusTestnetDomain,
    };

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
    fn mainnet_domain_strings() {
        assert_eq!(
            AbacusMainnetDomain::from_str("ethereum").unwrap(),
            AbacusMainnetDomain::Ethereum,
        );
        assert_eq!(
            AbacusMainnetDomain::Ethereum.to_string(),
            "ethereum".to_string(),
        );

        // One where serialization has changed
        assert_eq!(
            AbacusMainnetDomain::from_str("bsc").unwrap(),
            AbacusMainnetDomain::BinanceSmartChain,
        );
        assert_eq!(
            AbacusMainnetDomain::BinanceSmartChain.to_string(),
            "bsc".to_string(),
        );

        // Invalid name
        assert!(AbacusMainnetDomain::from_str("foo").is_err());
    }

    #[test]
    fn testnet_domain_strings() {
        assert_eq!(
            AbacusTestnetDomain::from_str("arbitrumrinkeby").unwrap(),
            AbacusTestnetDomain::ArbitrumRinkeby,
        );
        assert_eq!(
            AbacusTestnetDomain::ArbitrumRinkeby.to_string(),
            "arbitrumrinkeby".to_string(),
        );

        // One where serialization has changed
        assert_eq!(
            AbacusTestnetDomain::from_str("bsctestnet").unwrap(),
            AbacusTestnetDomain::BinanceSmartChainTestnet,
        );
        assert_eq!(
            AbacusTestnetDomain::BinanceSmartChainTestnet.to_string(),
            "bsctestnet".to_string(),
        );

        // Invalid name
        assert!(AbacusTestnetDomain::from_str("foo").is_err());
    }

    #[test]
    fn local_test_chain_domain_strings() {
        assert_eq!(
            AbacusLocalTestChainDomain::from_str("test1").unwrap(),
            AbacusLocalTestChainDomain::Test1,
        );
        assert_eq!(
            AbacusLocalTestChainDomain::Test1.to_string(),
            "test1".to_string(),
        );

        // Invalid name
        assert!(AbacusLocalTestChainDomain::from_str("foo").is_err());
    }

    #[test]
    fn domain_strings() {
        assert_eq!(
            AbacusDomain::from_str("ethereum").unwrap(),
            AbacusDomain::Mainnet(AbacusMainnetDomain::Ethereum),
        );
        assert_eq!(
            AbacusDomain::Mainnet(AbacusMainnetDomain::Ethereum).to_string(),
            "ethereum".to_string(),
        );
    }

    #[test]
    fn domain_ids() {
        assert_eq!(
            AbacusDomain::try_from(0x657468u32).unwrap(),
            AbacusDomain::Mainnet(AbacusMainnetDomain::Ethereum),
        );

        assert_eq!(
            u32::from(AbacusDomain::Mainnet(AbacusMainnetDomain::Ethereum)),
            0x657468u32,
        );
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
