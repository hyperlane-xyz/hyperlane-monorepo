#![allow(missing_docs)]

use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use strum::{EnumIter, EnumString};

use crate::{ChainResult, HyperlaneProtocolError, H160};

#[derive(Debug, Clone)]
pub struct Address(pub bytes::Bytes);

#[derive(Debug, Clone)]
pub struct Balance(pub num::BigInt);

#[derive(Debug, Clone)]
pub struct ContractLocator {
    pub domain: HyperlaneDomain,
    pub address: Address,
}
impl std::fmt::Display for ContractLocator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}[@{}]+contract:0x{:x}",
            self.domain, self.domain as u32, self.address.0
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
        Address(bytes::Bytes::from(addr.as_bytes().to_owned()))
    }
}

impl From<&'_ Address> for H160 {
    fn from(addr: &Address) -> Self {
        H160::from_slice(addr.0.as_ref())
    }
}

/// All domains supported by Hyperlane.
#[derive(
    FromPrimitive, EnumString, strum::Display, EnumIter, PartialEq, Eq, Debug, Clone, Copy, Hash,
)]
#[strum(serialize_all = "lowercase")]
#[repr(u32)]
pub enum HyperlaneDomain {
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

    Zksync2Testnet = 280,

    // -- Local test chains --
    /// Test1 local chain
    Test1 = 13371,
    /// Test2 local chain
    Test2 = 13372,
    /// Test3 local chain
    Test3 = 13373,
}

impl From<HyperlaneDomain> for u32 {
    fn from(domain: HyperlaneDomain) -> Self {
        domain as u32
    }
}

impl TryFrom<u32> for HyperlaneDomain {
    type Error = HyperlaneProtocolError;

    fn try_from(domain_id: u32) -> Result<Self, Self::Error> {
        FromPrimitive::from_u32(domain_id).ok_or(HyperlaneProtocolError::UnknownDomainId(domain_id))
    }
}

impl PartialEq<u32> for HyperlaneDomain {
    fn eq(&self, other: &u32) -> bool {
        (*self as u32).eq(other)
    }
}

impl PartialEq<HyperlaneDomain> for u32 {
    fn eq(&self, other: &HyperlaneDomain) -> bool {
        self.eq(&(*other as u32))
    }
}

/// Types of Hyperlane domains.
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum HyperlaneDomainType {
    /// A mainnet.
    Mainnet,
    /// A testnet.
    Testnet,
    /// A local chain for testing (i.e. Hardhat node).
    LocalTestChain,
}

/// A selector for which base library should handle this domain.
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum HyperlaneDomainImpl {
    /// An EVM-based chain type which uses hyperlane-ethereum.
    Ethereum,
    /// A Fuel-based chain type which uses hyperlane-fuel.
    Fuel,
}

impl HyperlaneDomain {
    pub fn domain_type(&self) -> HyperlaneDomainType {
        use HyperlaneDomain::*;
        use HyperlaneDomainType::*;

        match self {
            Ethereum => Mainnet,
            Goerli => Testnet,

            Polygon => Mainnet,
            Mumbai => Testnet,

            Avalanche => Mainnet,
            Fuji => Testnet,

            Arbitrum => Mainnet,
            ArbitrumGoerli => Testnet,

            Optimism => Mainnet,
            OptimismGoerli => Testnet,

            BinanceSmartChain => Mainnet,
            BinanceSmartChainTestnet => Testnet,

            Celo => Mainnet,
            Alfajores => Testnet,

            Moonbeam => Mainnet,
            MoonbaseAlpha => Testnet,

            Zksync2Testnet => Testnet,

            Test1 => LocalTestChain,
            Test2 => LocalTestChain,
            Test3 => LocalTestChain,
        }
    }

    pub fn domain_impl(&self) -> HyperlaneDomainImpl {
        use HyperlaneDomain::*;
        use HyperlaneDomainImpl::Ethereum as Evm;

        match self {
            Ethereum => Evm,
            Goerli => Evm,

            Polygon => Evm,
            Mumbai => Evm,

            Avalanche => Evm,
            Fuji => Evm,

            Arbitrum => Evm,
            ArbitrumGoerli => Evm,

            Optimism => Evm,
            OptimismGoerli => Evm,

            BinanceSmartChain => Evm,
            BinanceSmartChainTestnet => Evm,

            Celo => Evm,
            Alfajores => Evm,

            Moonbeam => Evm,
            MoonbaseAlpha => Evm,

            Zksync2Testnet => Evm,

            Test1 => Evm,
            Test2 => Evm,
            Test3 => Evm,
        }
    }
}

impl From<HyperlaneDomain> for HyperlaneDomainType {
    fn from(d: HyperlaneDomain) -> Self {
        d.domain_type()
    }
}

impl From<HyperlaneDomain> for HyperlaneDomainImpl {
    fn from(d: HyperlaneDomain) -> Self {
        d.domain_impl()
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

    use crate::HyperlaneDomain;

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
        for ChainCoordinate { name, domain } in chain_coords.iter() {
            assert_eq!(
                HyperlaneDomain::try_from(domain.to_owned())
                    .unwrap()
                    .to_string(),
                name.to_owned()
            );
            assert_eq!(
                u32::from(HyperlaneDomain::from_str(name).unwrap()),
                domain.to_owned()
            );
        }
    }

    #[test]
    fn domain_strings() {
        assert_eq!(
            HyperlaneDomain::from_str("ethereum").unwrap(),
            HyperlaneDomain::Ethereum,
        );
        assert_eq!(
            HyperlaneDomain::Ethereum.to_string(),
            "ethereum".to_string(),
        );
    }

    #[test]
    fn domain_ids() {
        assert_eq!(
            HyperlaneDomain::try_from(1).unwrap(),
            HyperlaneDomain::Ethereum,
        );

        assert_eq!(u32::from(HyperlaneDomain::Ethereum), 1);
    }

    #[test]
    fn test_name_from_domain_id() {
        assert_eq!(
            HyperlaneDomain::try_from(1).unwrap().to_string(),
            "ethereum"
        );
        assert!(HyperlaneDomain::try_from(0xf00u32).is_err());
    }

    #[test]
    fn test_domain_id_from_name() {
        assert_eq!(
            "ethereum".parse::<HyperlaneDomain>().map(|v| v as u32),
            Ok(1)
        );
        assert!("foo".parse::<HyperlaneDomain>().is_err());
    }
}
