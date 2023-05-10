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
pub struct ContractLocator<'a> {
    pub domain: &'a HyperlaneDomain,
    pub address: H256,
}
impl<'a> Display for ContractLocator<'a> {
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
    Sepolia = 11155111,

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

impl HyperlaneDomain {
    pub fn is_arbitrum_nitro(&self) -> bool {
        matches!(
            self,
            HyperlaneDomain::Known(
                KnownHyperlaneDomain::Arbitrum | KnownHyperlaneDomain::ArbitrumGoerli,
            )
        )
    }
}

#[cfg(any(test, feature = "test-utils"))]
impl HyperlaneDomain {
    pub fn new_test_domain(name: &str) -> Self {
        Self::Unknown {
            domain_id: 0,
            chain_name: name.to_owned(),
            domain_type: HyperlaneDomainType::LocalTestChain,
            domain_protocol: HyperlaneDomainProtocol::Ethereum,
        }
    }
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

impl HyperlaneDomainProtocol {
    pub fn fmt_address(&self, addr: H256) -> String {
        use HyperlaneDomainProtocol::*;
        match self {
            Ethereum => format!("{:?}", H160::from(addr)),
            Fuel => format!("{:?}", addr),
        }
    }
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
                Moonbeam,
                Gnosis
            ],
            Testnet: [
                Goerli, Mumbai, Fuji, ArbitrumGoerli, OptimismGoerli, BinanceSmartChainTestnet,
                Alfajores, MoonbaseAlpha, Zksync2Testnet, Sepolia
            ],
            LocalTestChain: [Test1, Test2, Test3, FuelTest1],
        })
    }

    pub const fn domain_protocol(self) -> HyperlaneDomainProtocol {
        use KnownHyperlaneDomain::*;

        many_to_one!(match self {
            HyperlaneDomainProtocol::Ethereum: [
                Ethereum, Goerli, Sepolia, Polygon, Mumbai, Avalanche, Fuji, Arbitrum, ArbitrumGoerli,
                Optimism, OptimismGoerli, BinanceSmartChain, BinanceSmartChainTestnet, Celo, Gnosis,
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

#[derive(thiserror::Error, Debug)]
pub enum HyperlaneDomainConfigError {
    #[error("Domain name (`{0}`) does not match the name of a known domain id; the name is probably misspelled.")]
    UnknownDomainName(String),
    #[error("The domain name (`{0}`) implies a different domain than the domain id provided; the domain id ({1}) is probably wrong.")]
    DomainNameMismatch(String, u32),
}

impl HyperlaneDomain {
    pub fn from_config(
        domain_id: u32,
        name: &str,
        protocol: HyperlaneDomainProtocol,
    ) -> Result<Self, HyperlaneDomainConfigError> {
        let name = name.to_ascii_lowercase();
        if let Ok(domain) = KnownHyperlaneDomain::try_from(domain_id) {
            if name == domain.as_str() {
                Ok(HyperlaneDomain::Known(domain))
            } else {
                Err(HyperlaneDomainConfigError::UnknownDomainName(name))
            }
        } else if name.as_str().parse::<KnownHyperlaneDomain>().is_ok() {
            Err(HyperlaneDomainConfigError::DomainNameMismatch(
                name, domain_id,
            ))
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
    use crate::KnownHyperlaneDomain;
    use std::str::FromStr;

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
