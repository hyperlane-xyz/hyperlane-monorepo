#![allow(missing_docs)]

use std::fmt::{Debug, Display, Formatter};
use std::hash::{Hash, Hasher};

use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use strum::{EnumIter, EnumString, IntoStaticStr};

use crate::utils::many_to_one;
use crate::{ChainResult, HyperlaneProtocolError, H160, H256};

#[derive(Debug, Clone)]
pub struct Address(pub bytes::Bytes);

#[derive(Debug, Clone)]
pub struct Balance(pub num::BigInt);

#[derive(Debug, Clone)]
pub struct ContractLocator {
    pub domain: HyperlaneDomain,
    pub address: H256,
}
impl Display for ContractLocator {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}[@{}]+contract:0x{:x}",
            self.domain.name(),
            self.domain.id(),
            self.address
        )
    }
}

#[async_trait::async_trait]
pub trait Chain {
    /// Query the balance on a chain
    async fn query_balance(&self, addr: Address) -> ChainResult<Balance>;
}

impl From<Address> for H160 {
    fn from(addr: Address) -> Self {
        H160::from_slice(addr.0.as_ref())
    }
}

impl From<H160> for Address {
    fn from(addr: H160) -> Self {
        Address(addr.as_bytes().to_owned().into())
    }
}

impl From<&'_ Address> for H160 {
    fn from(addr: &Address) -> Self {
        H160::from_slice(addr.0.as_ref())
    }
}

/// All domains supported by Hyperlane.
#[derive(
    FromPrimitive,
    EnumString,
    IntoStaticStr,
    strum::Display,
    EnumIter,
    PartialEq,
    Eq,
    Debug,
    Clone,
    Copy,
    Hash,
)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum KnownHyperlaneDomain {
    Ethereum = 1,
    Goerli = 5,

    Polygon = 137,
    Mumbai = 80001,

    Avalanche = 43114,
    Fuji = 43113,

    Arbitrum = 42161,
    ArbitrumGoerli = 421613,

    Optimism = 10,
    OptimismGoerli = 420,

    #[strum(serialize = "bsc")]
    BinanceSmartChain = 56,
    #[strum(serialize = "bsctestnet")]
    BinanceSmartChainTestnet = 97,

    Celo = 42220,
    Alfajores = 44787,

    Moonbeam = 1284,
    MoonbaseAlpha = 1287,

    Gnosis = 100,

    Zksync2Testnet = 280,

    // -- Local test chains --
    /// Test1 local chain
    Test1 = 13371,
    /// Test2 local chain
    Test2 = 13372,
    /// Test3 local chain
    Test3 = 13373,

    /// Fuel1 local chain
    FuelTest1 = 13374,
}

#[derive(Clone)]
pub enum HyperlaneDomain {
    Known(KnownHyperlaneDomain),
    Unknown {
        domain_id: u32,
        chain_name: String,
        domain_type: HyperlaneDomainType,
        domain_protocol: HyperlaneDomainProtocol,
    },
}

/// Types of Hyperlane domains.
#[derive(
    FromPrimitive, EnumString, IntoStaticStr, strum::Display, Copy, Clone, Eq, PartialEq, Debug,
)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum HyperlaneDomainType {
    /// A mainnet.
    Mainnet,
    /// A testnet.
    Testnet,
    /// A local chain for testing (i.e. Hardhat node).
    LocalTestChain,
    /// User provided chain of an unknown domain type.
    Unknown,
}

/// A selector for which base library should handle this domain.
#[derive(
    FromPrimitive, EnumString, IntoStaticStr, strum::Display, Copy, Clone, Eq, PartialEq, Debug,
)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum HyperlaneDomainProtocol {
    /// An EVM-based chain type which uses hyperlane-ethereum.
    Ethereum,
    /// A Fuel-based chain type which uses hyperlane-fuel.
    Fuel,
}

impl KnownHyperlaneDomain {
    pub fn as_str(self) -> &'static str {
        self.into()
    }

    pub const fn domain_type(self) -> HyperlaneDomainType {
        use self::{HyperlaneDomainType::*, KnownHyperlaneDomain::*};

        many_to_one!(match self {
            Mainnet: [
                Ethereum, Avalanche, Arbitrum, Polygon, Optimism, BinanceSmartChain, Celo,
                Moonbeam
            ],
            Testnet: [
                Goerli, Mumbai, Fuji, ArbitrumGoerli, OptimismGoerli, BinanceSmartChainTestnet,
                Alfajores, MoonbaseAlpha, Zksync2Testnet
            ],
            LocalTestChain: [Test1, Test2, Test3, FuelTest1],
        })
    }

    pub const fn domain_protocol(self) -> HyperlaneDomainProtocol {
        use KnownHyperlaneDomain::*;

        many_to_one!(match self {
            HyperlaneDomainProtocol::Ethereum: [
                Ethereum, Goerli, Polygon, Mumbai, Avalanche, Fuji, Arbitrum, ArbitrumGoerli,
                Optimism, OptimismGoerli, BinanceSmartChain, BinanceSmartChainTestnet, Celo,
                Alfajores, Moonbeam, MoonbaseAlpha, Zksync2Testnet, Test1, Test2, Test3
            ],
            HyperlaneDomainProtocol::Fuel: [FuelTest1],
        })
    }
}

impl PartialEq<Self> for HyperlaneDomain {
    fn eq(&self, other: &Self) -> bool {
        self.id() == other.id()
    }
}

impl Eq for HyperlaneDomain {}

impl Hash for HyperlaneDomain {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.id().hash(state)
    }
}

impl AsRef<str> for HyperlaneDomain {
    fn as_ref(&self) -> &str {
        self.name()
    }
}

impl From<&HyperlaneDomain> for u32 {
    fn from(domain: &HyperlaneDomain) -> Self {
        domain.id()
    }
}

impl TryFrom<u32> for KnownHyperlaneDomain {
    type Error = HyperlaneProtocolError;

    fn try_from(domain_id: u32) -> Result<Self, Self::Error> {
        FromPrimitive::from_u32(domain_id).ok_or(HyperlaneProtocolError::UnknownDomainId(domain_id))
    }
}

impl From<&HyperlaneDomain> for HyperlaneDomainType {
    fn from(d: &HyperlaneDomain) -> Self {
        d.domain_type()
    }
}

impl From<&HyperlaneDomain> for HyperlaneDomainProtocol {
    fn from(d: &HyperlaneDomain) -> Self {
        d.domain_protocol()
    }
}

impl Display for HyperlaneDomain {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name())
    }
}

impl Debug for HyperlaneDomain {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "HyperlaneDomain({} ({}))", self.name(), self.id())
    }
}

impl HyperlaneDomain {
    pub fn from_config(
        domain_id: u32,
        name: &str,
        protocol: HyperlaneDomainProtocol,
    ) -> Result<Self, &'static str> {
        let name = name.to_ascii_lowercase();
        if let Ok(domain) = KnownHyperlaneDomain::try_from(domain_id) {
            if name == domain.as_str() {
                Ok(HyperlaneDomain::Known(domain))
            } else {
                Err("Chain name does not match the name of a known domain id; the config is probably wrong.")
            }
        } else if name.as_str().parse::<KnownHyperlaneDomain>().is_ok() {
            Err("Chain name is known the domain is incorrect; the config is probably wrong.")
        } else {
            Ok(HyperlaneDomain::Unknown {
                domain_id,
                chain_name: name,
                // we might want to support accepting these from the config later
                domain_type: HyperlaneDomainType::Unknown,
                domain_protocol: protocol,
            })
        }
    }

    pub fn from_config_strs(
        domain_id: &str,
        name: &str,
        protocol: HyperlaneDomainProtocol,
    ) -> Result<Self, &'static str> {
        HyperlaneDomain::from_config(
            domain_id
                .parse::<u32>()
                .map_err(|_| "Domain id is an invalid uint")?,
            name,
            protocol,
        )
    }

    /// The chain name
    pub fn name(&self) -> &str {
        match self {
            HyperlaneDomain::Known(domain) => domain.as_str(),
            HyperlaneDomain::Unknown { chain_name, .. } => chain_name.as_str(),
        }
    }

    /// The domain id
    pub const fn id(&self) -> u32 {
        match self {
            HyperlaneDomain::Known(domain) => *domain as u32,
            HyperlaneDomain::Unknown { domain_id, .. } => *domain_id,
        }
    }

    /// Type of domain this is
    pub const fn domain_type(&self) -> HyperlaneDomainType {
        match self {
            HyperlaneDomain::Known(domain) => domain.domain_type(),
            HyperlaneDomain::Unknown { domain_type, .. } => *domain_type,
        }
    }

    /// Backend implementation for this domain
    pub const fn domain_protocol(&self) -> HyperlaneDomainProtocol {
        match self {
            HyperlaneDomain::Known(domain) => domain.domain_protocol(),
            HyperlaneDomain::Unknown {
                domain_protocol, ..
            } => *domain_protocol,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs::read_to_string;
    use std::path::Path;
    use std::str::FromStr;

    use config::{Config, File, FileFormat};
    use walkdir::WalkDir;

    use hyperlane_base::Settings;

    use crate::KnownHyperlaneDomain;

    /// Relative path to the `hyperlane-monorepo/rust/config/`
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
        "test/test_config.json",
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

    /// Provides a vector of parsed `hyperlane_base::Settings` objects
    /// built from all of the version-controlled agent configuration files.
    /// This is purely a utility to allow us to test a handful of critical
    /// properties related to those configs and shouldn't be used outside
    /// of a test env. This test simply tries to do some sanity checks
    /// against the integrity of that data.
    fn hyperlane_settings() -> Vec<Settings> {
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

    fn chain_name_domain_records() -> BTreeSet<ChainCoordinate> {
        hyperlane_settings()
            .iter()
            .flat_map(|x: &Settings| {
                x.chains.iter().map(|(_, v)| ChainCoordinate {
                    name: v.name.clone(),
                    domain: v.domain.parse().unwrap(),
                })
            })
            .collect()
    }

    #[test]
    fn agent_json_config_consistency_checks() {
        // TODO(webbhorn): Also verify with this functionality
        // we have entries for all of the Gelato contract
        // addresses we need hardcoded in the binary for now.

        // Verify that the hard-coded, macro-maintained
        // mapping in `hyperlane-core/src/chain.rs` named
        // by the macro `domain_and_chain` is complete
        // and in agreement with our on-disk json-based
        // configuration data.
        let chain_coords = chain_name_domain_records();
        for ChainCoordinate { name, domain } in chain_coords.into_iter() {
            assert_eq!(
                KnownHyperlaneDomain::try_from(domain).unwrap().to_string(),
                name
            );
            assert_eq!(
                KnownHyperlaneDomain::from_str(&name).unwrap() as u32,
                domain
            );
        }
    }

    #[test]
    fn domain_strings() {
        assert_eq!(
            KnownHyperlaneDomain::from_str("ethereum").unwrap(),
            KnownHyperlaneDomain::Ethereum,
        );
        assert_eq!(
            KnownHyperlaneDomain::Ethereum.to_string(),
            "ethereum".to_string(),
        );
    }

    #[test]
    fn domain_ids() {
        assert_eq!(
            KnownHyperlaneDomain::try_from(1).unwrap(),
            KnownHyperlaneDomain::Ethereum,
        );

        assert_eq!(KnownHyperlaneDomain::Ethereum as u32, 1);
    }

    #[test]
    fn test_name_from_domain_id() {
        assert_eq!(
            KnownHyperlaneDomain::try_from(1).unwrap().to_string(),
            "ethereum"
        );
        assert_eq!(
            KnownHyperlaneDomain::try_from(1).unwrap().as_str(),
            "ethereum"
        );
        assert!(KnownHyperlaneDomain::try_from(0xf00u32).is_err());
    }

    #[test]
    fn test_domain_id_from_name() {
        assert_eq!(
            "ethereum".parse::<KnownHyperlaneDomain>().map(|v| v as u32),
            Ok(1)
        );
        assert_eq!(
            "EthEreum".parse::<KnownHyperlaneDomain>().map(|v| v as u32),
            Ok(1)
        );
        assert_eq!(
            "Bsc".parse::<KnownHyperlaneDomain>().map(|v| v as u32),
            Ok(56)
        );
        assert!("foo".parse::<KnownHyperlaneDomain>().is_err());
    }
}
