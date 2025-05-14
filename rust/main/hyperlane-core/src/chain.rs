#![allow(missing_docs)]

use std::{
    fmt::{Debug, Formatter},
    hash::{Hash, Hasher},
    num::NonZeroU32,
};

use derive_new::new;
use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[cfg(feature = "strum")]
use strum::{EnumIter, EnumString, IntoStaticStr};

use crate::{
    utils::many_to_one, ChainCommunicationError, HyperlaneProtocolError, IndexMode, H160, H256,
};

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

#[derive(Default, Debug, Clone, PartialEq)]
pub enum ReorgPeriod {
    #[default]
    None,
    Blocks(NonZeroU32),
    Tag(String),
}

impl ReorgPeriod {
    pub fn from_blocks(blocks: u32) -> Self {
        NonZeroU32::try_from(blocks)
            .map(ReorgPeriod::Blocks)
            .unwrap_or(ReorgPeriod::None)
    }

    pub fn as_blocks(&self) -> Result<u32, ChainCommunicationError> {
        match self {
            ReorgPeriod::None => Ok(0),
            ReorgPeriod::Blocks(blocks) => Ok(blocks.get()),
            ReorgPeriod::Tag(_) => Err(ChainCommunicationError::InvalidReorgPeriod(self.clone())),
        }
    }

    pub fn is_none(&self) -> bool {
        matches!(self, ReorgPeriod::None)
    }
}

impl Serialize for ReorgPeriod {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            ReorgPeriod::None => serializer.serialize_u32(0),
            ReorgPeriod::Blocks(blocks) => serializer.serialize_u32(blocks.get()),
            ReorgPeriod::Tag(tag) => serializer.serialize_str(tag),
        }
    }
}

impl<'de> Deserialize<'de> for ReorgPeriod {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::de;

        struct ReorgPeriodVisitor;

        impl<'de> de::Visitor<'de> for ReorgPeriodVisitor {
            type Value = ReorgPeriod;

            fn expecting(&self, f: &mut Formatter) -> std::fmt::Result {
                f.write_str("reorgPeriod as a number or string")
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                let v = v.try_into().map_err(de::Error::custom)?;
                Ok(ReorgPeriod::from_blocks(v))
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                match v.parse::<u32>() {
                    Ok(v) => self.visit_u32(v),
                    Err(_) => Ok(ReorgPeriod::Tag(v.to_string())),
                }
            }
        }

        deserializer.deserialize_any(ReorgPeriodVisitor)
    }
}

/// All domains supported by Hyperlane.
#[derive(FromPrimitive, PartialEq, Eq, Debug, Clone, Copy, Hash, Serialize)]
#[cfg_attr(
    feature = "strum",
    derive(strum::Display, EnumString, IntoStaticStr, EnumIter)
)]
#[cfg_attr(
    feature = "strum",
    strum(serialize_all = "lowercase", ascii_case_insensitive)
)]
pub enum KnownHyperlaneDomain {
    Ancient8 = 888888888,
    Arbitrum = 42161,
    Avalanche = 43114,
    #[cfg_attr(feature = "strum", strum(serialize = "bsc"))]
    BinanceSmartChain = 56,
    Blast = 81457,
    Bob = 60808,
    Celo = 42220,
    Cheesechain = 383353,
    Cyber = 7560,
    DegenChain = 666666666,
    EclipseMainnet = 1408864445,
    Endurance = 648,
    Ethereum = 1,
    Fraxtal = 252,
    Fuji = 43113,
    FuseMainnet = 122,
    Gnosis = 100,
    InEvm = 2525,
    Injective = 6909546,
    Kroma = 255,
    Linea = 59144,
    Lisk = 1135,
    Lukso = 42,
    MantaPacific = 169,
    Mantle = 5000,
    Merlin = 4200,
    Metis = 1088,
    Mint = 185,
    Mode = 34443,
    Moonbeam = 1284,
    Neutron = 1853125230,
    Optimism = 10,
    Osmosis = 875,
    Polygon = 137,
    ProofOfPlay = 70700,
    ReAl = 111188,
    Redstone = 690,
    Sanko = 1996,
    Sei = 1329,
    SolanaMainnet = 1399811149,
    Taiko = 167000,
    Tangle = 5845,
    Treasure = 61166,
    Viction = 88,
    Worldchain = 480,
    Xai = 660279,
    Xlayer = 196,
    Zetachain = 7000,
    Zeronetwork = 543210,
    Zklink = 810180,
    Zksync = 324,
    Zircuit = 48900,
    ZoraMainnet = 7777777,

    // -- Local chains --
    //
    Test1 = 9913371,
    Test2 = 9913372,
    Test3 = 9913373,
    FuelTest1 = 13374,
    SealevelTest1 = 13375,
    SealevelTest2 = 13376,
    CosmosTest99990 = 99990,
    CosmosTest99991 = 99991,
    CosmosTestNative1 = 75898670,
    CosmosTestNative2 = 75898671,

    // -- Test chains --
    //
    Abstracttestnet = 11124,
    Alfajores = 44787,
    #[cfg_attr(feature = "strum", strum(serialize = "bsctestnet"))]
    BinanceSmartChainTestnet = 97,
    Chiado = 10200,
    ConnextSepolia = 6398,
    Holesky = 17000,
    MoonbaseAlpha = 1287,
    KyveAlpha = 75898669,
    PlumeTestnet = 161221135,
    ScrollSepolia = 534351,
    Sepolia = 11155111,
    SuperpositionTestnet = 98985,
}

#[derive(Clone, Serialize)]
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
#[derive(FromPrimitive, Copy, Clone, Eq, PartialEq, Debug, Serialize)]
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
#[derive(FromPrimitive, Copy, Clone, Eq, PartialEq, Debug, Serialize)]
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
    /// A Cosmos based chain with uses a module instead of a contract.
    CosmosNative,
}

impl HyperlaneDomainProtocol {
    pub fn fmt_address(&self, addr: H256) -> String {
        use HyperlaneDomainProtocol::*;
        match self {
            Ethereum => format!("{:?}", H160::from(addr)),
            _ => format!("{:?}", addr),
        }
    }
}

/// Hyperlane domain technical stack types.
#[derive(Default, FromPrimitive, Copy, Clone, Eq, PartialEq, Debug, Serialize)]
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
    OpStack,
    PolygonCDK,
    PolkadotSubstrate,
    ZkSync,
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
                Ancient8, Arbitrum, Avalanche, BinanceSmartChain, Blast, Bob, Celo, Cheesechain, Cyber,
                DegenChain, EclipseMainnet, Endurance, Ethereum, Fraxtal, FuseMainnet, Gnosis,
                InEvm, Injective, Kroma, Linea, Lisk, Lukso, MantaPacific, Mantle, Merlin,
                Metis, Mint, Mode, Moonbeam, Neutron, Optimism, Osmosis, Polygon, ProofOfPlay,
                ReAl, Redstone, Sanko, Sei, SolanaMainnet, Taiko, Tangle, Treasure, Viction, Worldchain, Xai,
                Xlayer, Zeronetwork, Zetachain, Zircuit, Zklink, Zksync, ZoraMainnet,
            ],
            Testnet: [
                Alfajores, BinanceSmartChainTestnet, Chiado, ConnextSepolia, Fuji, Holesky, MoonbaseAlpha,
                PlumeTestnet, ScrollSepolia, Sepolia, SuperpositionTestnet, Abstracttestnet
            ],
            LocalTestChain: [
                Test1, Test2, Test3, FuelTest1, SealevelTest1, SealevelTest2, CosmosTest99990,
                CosmosTest99991, CosmosTestNative1, CosmosTestNative2, KyveAlpha
            ],
        })
    }

    pub const fn domain_protocol(self) -> HyperlaneDomainProtocol {
        use KnownHyperlaneDomain::*;

        many_to_one!(match self {
            HyperlaneDomainProtocol::Ethereum: [
                Abstracttestnet, Ancient8, Arbitrum, Avalanche, BinanceSmartChain, Blast, Bob, Celo, Cheesechain, Cyber,
                DegenChain, Endurance, Ethereum, Fraxtal, Fuji, FuseMainnet, Gnosis,
                InEvm, Kroma, Linea, Lisk, Lukso, MantaPacific, Mantle, Merlin, Metis, Mint,
                Mode, Moonbeam, Optimism, Polygon, ProofOfPlay, ReAl, Redstone, Sanko, Sei, Tangle,
                Taiko, Treasure, Viction, Worldchain, Xai, Xlayer, Zeronetwork, Zetachain, Zircuit, ZoraMainnet,
                Zklink, Zksync,

                // Local chains
                Test1, Test2, Test3,

                // Test chains
                Alfajores, BinanceSmartChainTestnet, Chiado, ConnextSepolia, Holesky, MoonbaseAlpha, PlumeTestnet,
                ScrollSepolia, Sepolia, SuperpositionTestnet,

            ],
            HyperlaneDomainProtocol::Fuel: [FuelTest1],
            HyperlaneDomainProtocol::Sealevel: [EclipseMainnet, SolanaMainnet, SealevelTest1, SealevelTest2],
            HyperlaneDomainProtocol::Cosmos: [
                Injective, Neutron, Osmosis,

                // Local chains
                CosmosTest99990, CosmosTest99991,
            ],
            HyperlaneDomainProtocol::CosmosNative: [
                CosmosTestNative1,
                CosmosTestNative2,
                KyveAlpha
            ]
        })
    }

    pub const fn domain_technical_stack(self) -> HyperlaneDomainTechnicalStack {
        use KnownHyperlaneDomain::*;

        many_to_one!(match self {
            HyperlaneDomainTechnicalStack::ArbitrumNitro: [
                Arbitrum, Cheesechain, DegenChain, InEvm, ProofOfPlay, ReAl, Sanko, Xai,

                // Test chains
                ConnextSepolia, PlumeTestnet, SuperpositionTestnet
            ],
            HyperlaneDomainTechnicalStack::OpStack: [
                Ancient8, Blast, Bob, Cyber, Fraxtal, Kroma, Lisk, MantaPacific, Mantle, Metis,
                Mint, Mode, Optimism, Redstone, Worldchain, Zircuit, ZoraMainnet
            ],
            HyperlaneDomainTechnicalStack::PolygonCDK: [
                Merlin, Xlayer
            ],
            HyperlaneDomainTechnicalStack::PolkadotSubstrate: [
                Moonbeam, Tangle
            ],
            HyperlaneDomainTechnicalStack::ZkSync: [
                Abstracttestnet, Treasure, Zeronetwork, Zklink, Zksync,
            ],
            HyperlaneDomainTechnicalStack::Other: [
                Avalanche, BinanceSmartChain, Celo, EclipseMainnet, Endurance, Ethereum,
                FuseMainnet, Gnosis, Injective, Linea, Lukso, Neutron, Osmosis, Polygon,
                Sei, SolanaMainnet, Taiko, Viction, Zetachain,

                // Local chains
                CosmosTest99990, CosmosTest99991, FuelTest1, SealevelTest1, SealevelTest2, Test1,
                Test2, Test3,
                CosmosTestNative1, CosmosTestNative2,

                // Test chains
                Alfajores, BinanceSmartChainTestnet, Chiado, Fuji, Holesky, MoonbaseAlpha, ScrollSepolia,
                Sepolia, KyveAlpha
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

    pub const fn is_zksync_stack(&self) -> bool {
        matches!(
            self.domain_technical_stack(),
            HyperlaneDomainTechnicalStack::ZkSync
        )
    }

    pub const fn index_mode(&self) -> IndexMode {
        use HyperlaneDomainProtocol::*;
        let protocol = self.domain_protocol();
        many_to_one!(match protocol {
            IndexMode::Block: [Ethereum, Cosmos, CosmosNative],
            IndexMode::Sequence : [Sealevel, Fuel],
        })
    }
}

/// Hyperlane domain protocol types.
#[derive(Copy, Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "strum",
    derive(strum::Display, EnumString, IntoStaticStr, EnumIter)
)]
pub enum SubmitterType {
    /// Classic
    #[default]
    Classic,
    /// Lander
    Lander,
}

#[cfg(test)]
#[cfg(feature = "strum")]
mod tests {
    use std::{num::NonZeroU32, str::FromStr};

    use crate::{KnownHyperlaneDomain, ReorgPeriod, SubmitterType};

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

    #[test]
    fn parse_reorg_period() {
        assert_eq!(
            serde_json::from_value::<ReorgPeriod>(0.into()).unwrap(),
            ReorgPeriod::None
        );

        assert_eq!(
            serde_json::from_value::<ReorgPeriod>("0".into()).unwrap(),
            ReorgPeriod::None
        );

        assert_eq!(
            serde_json::from_value::<ReorgPeriod>(12.into()).unwrap(),
            ReorgPeriod::Blocks(NonZeroU32::new(12).unwrap())
        );

        assert_eq!(
            serde_json::from_value::<ReorgPeriod>("12".into()).unwrap(),
            ReorgPeriod::Blocks(NonZeroU32::new(12).unwrap())
        );

        assert_eq!(
            serde_json::from_value::<ReorgPeriod>("finalized".into()).unwrap(),
            ReorgPeriod::Tag("finalized".into())
        );
    }

    #[test]
    fn parse_submitter_type() {
        assert_eq!(
            serde_json::from_value::<SubmitterType>("Classic".into()).unwrap(),
            SubmitterType::Classic
        );

        assert_eq!(
            serde_json::from_value::<SubmitterType>("Lander".into()).unwrap(),
            SubmitterType::Lander
        );
    }
}
