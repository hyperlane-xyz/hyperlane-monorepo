#![allow(missing_docs)]

use std::{
    fmt::{Debug, Formatter},
    hash::{Hash, Hasher},
};

use derive_new::new;
use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
#[cfg(feature = "strum")]
use strum::{EnumIter, EnumString, IntoStaticStr};

use crate::{utils::many_to_one, HyperlaneProtocolError, IndexMode, H160, H256};

#[derive(Debug, Clone)]
pub struct Address(pub bytes::Bytes);

#[derive(Debug, Clone)]
pub struct Balance(pub num::BigInt);

#[derive(Debug, Clone, new)]
pub struct ContractLocator<'a> {
    pub domain: &'a HyperlaneDomain,
    pub address: H256,
}

#[cfg(feature = "strum")]
impl<'a> std::fmt::Display for ContractLocator<'a> {
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

/// All domains supported by Hyperlane.
#[derive(FromPrimitive, PartialEq, Eq, Debug, Clone, Copy, Hash)]
#[cfg_attr(
    feature = "strum",
    derive(strum::Display, EnumString, IntoStaticStr, EnumIter)
)]
#[cfg_attr(
    feature = "strum",
    strum(serialize_all = "lowercase", ascii_case_insensitive)
)]
pub enum KnownHyperlaneDomain {
    Ethereum = 1,
    Sepolia = 11155111,

    Polygon = 137,

    Avalanche = 43114,
    Fuji = 43113,

    Arbitrum = 42161,

    Optimism = 10,

    #[cfg_attr(feature = "strum", strum(serialize = "bsc"))]
    BinanceSmartChain = 56,
    #[cfg_attr(feature = "strum", strum(serialize = "bsctestnet"))]
    BinanceSmartChainTestnet = 97,

    Celo = 42220,
    Alfajores = 44787,

    Moonbeam = 1284,
    MoonbaseAlpha = 1287,

    Gnosis = 100,
    Chiado = 10200,

    MantaPacific = 169,

    Neutron = 1853125230,

    Injective = 6909546,
    InEvm = 2525,

    PlumeTestnet = 161221135,

    // -- Local test chains --
    /// Test1 local chain
    Test1 = 13371,
    /// Test2 local chain
    Test2 = 13372,
    /// Test3 local chain
    Test3 = 13373,

    /// Fuel1 local chain
    FuelTest1 = 13374,

    /// Sealevel local chain 1
    SealevelTest1 = 13375,
    /// Sealevel local chain 1
    SealevelTest2 = 13376,

    // -- v3 testnets --
    ScrollSepolia = 534351,

    /// Cosmos local chains
    CosmosTest99990 = 99990,
    CosmosTest99991 = 99991,
}

#[derive(Clone)]
pub enum HyperlaneDomain {
    Known(KnownHyperlaneDomain),
    Unknown {
        domain_id: u32,
        domain_name: String,
        domain_type: HyperlaneDomainType,
        domain_protocol: HyperlaneDomainProtocol,
        domain_technical_stack: HyperlaneDomainTechnicalStack,
    },
}

#[cfg(any(test, feature = "test-utils"))]
impl HyperlaneDomain {
    pub fn new_test_domain(name: &str) -> Self {
        Self::Unknown {
            domain_id: 0,
            domain_name: name.to_owned(),
            domain_type: HyperlaneDomainType::LocalTestChain,
            domain_protocol: HyperlaneDomainProtocol::Ethereum,
            domain_technical_stack: HyperlaneDomainTechnicalStack::Other,
        }
    }
}

/// Types of Hyperlane domains.
#[derive(FromPrimitive, Copy, Clone, Eq, PartialEq, Debug)]
#[cfg_attr(
    feature = "strum",
    derive(strum::Display, EnumString, IntoStaticStr, EnumIter)
)]
#[cfg_attr(
    feature = "strum",
    strum(serialize_all = "lowercase", ascii_case_insensitive)
)]
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

/// Hyperlane domain protocol types.
#[derive(FromPrimitive, Copy, Clone, Eq, PartialEq, Debug)]
#[cfg_attr(
    feature = "strum",
    derive(strum::Display, EnumString, IntoStaticStr, EnumIter)
)]
#[cfg_attr(
    feature = "strum",
    strum(serialize_all = "lowercase", ascii_case_insensitive)
)]
pub enum HyperlaneDomainProtocol {
    /// An EVM-based chain type which uses hyperlane-ethereum.
    Ethereum,
    /// A Fuel-based chain type which uses hyperlane-fuel.
    Fuel,
    /// A Sealevel-based chain type which uses hyperlane-sealevel.
    Sealevel,
    /// A Cosmos-based chain type which uses hyperlane-cosmos.
    Cosmos,
}

impl HyperlaneDomainProtocol {
    pub fn fmt_address(&self, addr: H256) -> String {
        use HyperlaneDomainProtocol::*;
        match self {
            Ethereum => format!("{:?}", H160::from(addr)),
            Fuel => format!("{:?}", addr),
            Sealevel => format!("{:?}", addr),
            Cosmos => format!("{:?}", addr),
        }
    }
}

/// Hyperlane domain technical stack types.
#[derive(Default, FromPrimitive, Copy, Clone, Eq, PartialEq, Debug)]
#[cfg_attr(
    feature = "strum",
    derive(strum::Display, EnumString, IntoStaticStr, EnumIter)
)]
#[cfg_attr(
    feature = "strum",
    strum(serialize_all = "lowercase", ascii_case_insensitive)
)]
pub enum HyperlaneDomainTechnicalStack {
    ArbitrumNitro,
    #[default]
    Other,
}

impl KnownHyperlaneDomain {
    #[cfg(feature = "strum")]
    pub fn as_str(self) -> &'static str {
        self.into()
    }

    pub const fn domain_type(self) -> HyperlaneDomainType {
        use self::{HyperlaneDomainType::*, KnownHyperlaneDomain::*};

        many_to_one!(match self {
            Mainnet: [
                Ethereum, Avalanche, Arbitrum, Polygon, Optimism, BinanceSmartChain, Celo,
                Moonbeam, Gnosis, MantaPacific, Neutron, Injective, InEvm
            ],
            Testnet: [
                Alfajores, MoonbaseAlpha, Sepolia, ScrollSepolia, Chiado, PlumeTestnet, Fuji, BinanceSmartChainTestnet
            ],
            LocalTestChain: [Test1, Test2, Test3, FuelTest1, SealevelTest1, SealevelTest2, CosmosTest99990, CosmosTest99991],
        })
    }

    pub const fn domain_protocol(self) -> HyperlaneDomainProtocol {
        use KnownHyperlaneDomain::*;

        many_to_one!(match self {
            HyperlaneDomainProtocol::Ethereum: [
                Ethereum, Sepolia, Polygon, Avalanche, Fuji, Arbitrum,
                Optimism, BinanceSmartChain, BinanceSmartChainTestnet, Celo, Gnosis,
                Alfajores, Moonbeam, InEvm, MoonbaseAlpha, ScrollSepolia,
                Chiado, MantaPacific, PlumeTestnet, Test1, Test2, Test3
            ],
            HyperlaneDomainProtocol::Fuel: [FuelTest1],
            HyperlaneDomainProtocol::Sealevel: [SealevelTest1, SealevelTest2],
            HyperlaneDomainProtocol::Cosmos: [CosmosTest99990, CosmosTest99991, Neutron, Injective],
        })
    }

    pub const fn domain_technical_stack(self) -> HyperlaneDomainTechnicalStack {
        use KnownHyperlaneDomain::*;

        many_to_one!(match self {
            HyperlaneDomainTechnicalStack::ArbitrumNitro: [Arbitrum, PlumeTestnet],
            HyperlaneDomainTechnicalStack::Other: [
                Ethereum, Sepolia, Polygon, Avalanche, Fuji, Optimism,
                BinanceSmartChain, BinanceSmartChainTestnet, Celo, Gnosis, Alfajores, Moonbeam, MoonbaseAlpha,
                ScrollSepolia, Chiado, MantaPacific, Neutron, Injective, InEvm,
                Test1, Test2, Test3, FuelTest1, SealevelTest1, SealevelTest2, CosmosTest99990, CosmosTest99991
            ],
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

#[cfg(feature = "strum")]
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

#[cfg(feature = "strum")]
impl std::fmt::Display for HyperlaneDomain {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.name())
    }
}

impl Debug for HyperlaneDomain {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        #[cfg(feature = "strum")]
        {
            write!(f, "HyperlaneDomain({} ({}))", self.name(), self.id())
        }
        #[cfg(not(feature = "strum"))]
        {
            write!(f, "HyperlaneDomain({})", self.id())
        }
    }
}

impl From<KnownHyperlaneDomain> for HyperlaneDomain {
    fn from(domain: KnownHyperlaneDomain) -> Self {
        HyperlaneDomain::Known(domain)
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
    #[cfg(feature = "strum")]
    pub fn from_config(
        domain_id: u32,
        name: &str,
        protocol: HyperlaneDomainProtocol,
        domain_technical_stack: HyperlaneDomainTechnicalStack,
    ) -> Result<Self, HyperlaneDomainConfigError> {
        let name = name.to_ascii_lowercase();
        if let Ok(domain) = KnownHyperlaneDomain::try_from(domain_id) {
            if name == domain.as_str().to_ascii_lowercase() {
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
                domain_name: name,
                domain_protocol: protocol,
                // we might want to support accepting this from the config later
                domain_type: HyperlaneDomainType::Unknown,
                domain_technical_stack,
            })
        }
    }

    /// The chain name
    #[cfg(feature = "strum")]
    pub fn name(&self) -> &str {
        match self {
            HyperlaneDomain::Known(domain) => domain.as_str(),
            HyperlaneDomain::Unknown {
                domain_name: chain_name,
                ..
            } => chain_name.as_str(),
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

    pub const fn domain_technical_stack(&self) -> HyperlaneDomainTechnicalStack {
        match self {
            HyperlaneDomain::Known(domain) => domain.domain_technical_stack(),
            HyperlaneDomain::Unknown {
                domain_technical_stack,
                ..
            } => *domain_technical_stack,
        }
    }

    pub const fn is_arbitrum_nitro(&self) -> bool {
        matches!(
            self.domain_technical_stack(),
            HyperlaneDomainTechnicalStack::ArbitrumNitro
        )
    }

    pub const fn is_injective(&self) -> bool {
        matches!(self, Self::Known(KnownHyperlaneDomain::Injective))
    }

    pub const fn index_mode(&self) -> IndexMode {
        use HyperlaneDomainProtocol::*;
        let protocol = self.domain_protocol();
        many_to_one!(match protocol {
            IndexMode::Block: [Ethereum, Cosmos],
            IndexMode::Sequence : [Sealevel, Fuel],
        })
    }
}

#[cfg(test)]
#[cfg(feature = "strum")]
mod tests {
    use std::str::FromStr;

    use crate::KnownHyperlaneDomain;

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
