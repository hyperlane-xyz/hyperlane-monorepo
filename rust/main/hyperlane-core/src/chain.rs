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

use crate::{ChainCommunicationError, HyperlaneProtocolError, IndexMode, H160, H256};

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
impl std::fmt::Display for ContractLocator<'_> {
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

        impl de::Visitor<'_> for ReorgPeriodVisitor {
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
    Abstract = 2741,
    AppChain = 466,
    Ancient8 = 888888888,
    ApeChain = 33139,
    Arbitrum = 42161,
    ArbitrumNova = 42170,
    Arcadia = 4278608,
    Artela = 11820,
    Astar = 592,
    Aurora = 1313161554,
    Avalanche = 43114,
    Base = 8453,
    BeraChain = 80094,
    #[cfg_attr(feature = "strum", strum(serialize = "bsc"))]
    BinanceSmartChain = 56,
    Blast = 81457,
    Bitlayer = 200901,
    Bob = 60808,
    Boba = 288,
    Botanix = 3637,
    BSquared = 223,
    B3 = 8333,
    Celo = 42220,
    Cheesechain = 383353,
    ChilizMainnet = 1000088888,
    CoreDao = 1116,
    Corn = 21000000,
    Coti = 2632500,
    Cyber = 7560,
    DegenChain = 666666666,
    DogeChain = 2000,
    EclipseMainnet = 1408864445,
    EdgenChain = 4207,
    Everclear = 25327,
    Endurance = 648,
    Ethereum = 1,
    Fantom = 250,
    Flare = 14,
    FlowMainnet = 1000000747,
    Fluence = 9999999,
    Form = 478,
    Forma = 984122,
    Fraxtal = 252,
    Fuji = 43113,
    FuseMainnet = 122,
    Galactica = 613419,
    Glue = 1300,
    Gnosis = 100,
    Gravity = 1625,
    Guru = 260,
    Harmony = 1666600000,
    HashKey = 177,
    Hemi = 43111,
    HyperEvm = 999,
    ImmutableZkEvmMainnet = 1000013371,
    InEvm = 2525,
    Ink = 57073,
    Injective = 6909546,
    Kaia = 8217,
    Katana = 747474,
    Kyve = 1264145989,
    Linea = 59144,
    Lisk = 1135,
    Lukso = 42,
    LumiaPrism = 1000073017,
    MantaPacific = 169,
    Mantle = 5000,
    Merlin = 4200,
    Metal = 1000001750,
    Metis = 1088,
    MiracleChain = 92278,
    Milkyway = 1835625579,
    Mint = 185,
    Mode = 34443,
    Molten = 360,
    Moonbeam = 1284,
    Morph = 2818,
    Neutron = 1853125230,
    Nibiru = 6900,
    Noble = 1313817164,
    Ontology = 58,
    OortMainnet = 970,
    OpBnb = 204,
    Optimism = 10,
    Orderly = 291,
    Osmosis = 875,
    Paradex = 514051890,
    Peaq = 3338,
    Plume = 98866,
    Polygon = 137,
    PolygonZkEvm = 1101,
    Prom = 227,
    ProofOfPlay = 70700,
    Rarichain = 1000012617,
    Ronin = 2020,
    Reactive = 1597,
    Redstone = 690,
    Sei = 1329,
    Scroll = 534352,
    Shibarium = 109,
    SolanaMainnet = 1399811149,
    Solaxy = 1936682104,
    Sophon = 50104,
    Soneium = 1868,
    SonicSvm = 507150715,
    Soon = 50075007,
    Sonic = 146,
    Starknet = 358974494,
    Story = 1514,
    Stride = 745,
    SubTensor = 964,
    SuperpositionMainnet = 1000055244,
    Superseed = 5330,
    SvmBnb = 574456,
    Swell = 1923,
    Tac = 239,
    Taiko = 167000,
    Tangle = 5845,
    Torus = 21000,
    Treasure = 61166,
    Unichain = 130,
    Vana = 1480,
    Viction = 88,
    Worldchain = 480,
    StarknetMainnet = 23448592,
    Xai = 660279,
    Xlayer = 196,
    XrplEvm = 1440000,
    Zetachain = 7000,
    Zeronetwork = 543210,
    Zksync = 324,
    Zircuit = 48900,
    ZoraMainnet = 7777777,

    // -- Test chains --
    //
    ArbitrumSepolia = 421614,
    ArcadiaTestnet2 = 1098411886,
    AuroraTestnet = 1313161555,
    BasecampTestnet = 1000001114,
    BaseSepolia = 84532,
    #[cfg_attr(feature = "strum", strum(serialize = "bsctestnet"))]
    BinanceSmartChainTestnet = 97,
    CarrchainTestnet = 76672,
    CelestiaTestnet = 1297040200,
    Chiado = 10200,
    CitreaTestnet = 5115,
    CotiTestnet = 7082400,
    EclipseTestnet = 239092742,
    Holesky = 17000,
    HyperLiquidEvmTestnet = 998,
    KyveTestnet = 1262571342,
    Matchain = 698,
    MegaEthTestnet = 6342,
    MilkywayTestnet = 1162171030,
    ModeTestnet = 919,
    MonadTestnet = 10143,
    MoonbaseAlpha = 1287,
    NeuraTestnet = 267,
    NobleTestnet = 1196573006,
    KyveAlpha = 75898669,
    OptimismSepolia = 11155420,
    ParadexSepolia = 12263410,
    PlumeTestnet = 161221135,
    Polygonamoy = 80002,
    PolynomialFi = 1000008008,
    PragmaDevnet = 6363709,
    Radix = 1633970780,
    RadixTestnet = 1280787160,
    ScrollSepolia = 534351,
    Sepolia = 11155111,
    SolanaTestnet = 1399811150,
    SomniaTestnet = 50312,
    SonicSvmTestnet = 15153042,
    StarknetSepolia = 23448591,
    SubtensorTestnet = 945,

    // -- Local chains --
    //
    Test1 = 9913371,
    Test2 = 9913372,
    Test3 = 9913373,
    Test4 = 31337,
    FuelTest1 = 13374,
    SealevelTest1 = 13375,
    SealevelTest2 = 13376,
    CosmosTest99990 = 99990,
    CosmosTest99991 = 99991,
    StarknetTest23448593 = 23448593,
    StarknetTest23448594 = 23448594,
    CosmosTestNative1 = 75898670,
    CosmosTestNative2 = 75898671,
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
    /// A Starknet-based chain type which uses hyperlane-starknet.
    Starknet,
    /// A Cosmos based chain with uses a module instead of a contract.
    CosmosNative,
    /// A Raidx based chain
    Radix,
    /// A Sovereign-based chain type which uses hyperlane-sovereign.
    Sovereign,
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
    Starknet,
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
        use self::KnownHyperlaneDomain::*;

        match self {
            ArbitrumSepolia
            | ArcadiaTestnet2
            | AuroraTestnet
            | BasecampTestnet
            | BaseSepolia
            | BinanceSmartChainTestnet
            | CarrchainTestnet
            | CelestiaTestnet
            | Chiado
            | CitreaTestnet
            | CotiTestnet
            | EclipseTestnet
            | Holesky
            | HyperLiquidEvmTestnet
            | KyveTestnet
            | MegaEthTestnet
            | MilkywayTestnet
            | ModeTestnet
            | MonadTestnet
            | MoonbaseAlpha
            | NeuraTestnet
            | NobleTestnet
            | OptimismSepolia
            | ParadexSepolia
            | PlumeTestnet
            | Polygonamoy
            | PragmaDevnet
            | RadixTestnet
            | ScrollSepolia
            | Sepolia
            | SolanaTestnet
            | SomniaTestnet
            | SonicSvmTestnet
            | StarknetSepolia
            | SubtensorTestnet
            | KyveAlpha => HyperlaneDomainType::Testnet,
            Test1 | Test2 | Test3 | Test4 | FuelTest1 | SealevelTest1 | SealevelTest2
            | CosmosTest99990 | CosmosTest99991 | CosmosTestNative1 | CosmosTestNative2
            | StarknetTest23448593 | StarknetTest23448594 => HyperlaneDomainType::LocalTestChain,
            _ => HyperlaneDomainType::Mainnet,
        }
    }

    pub const fn domain_protocol(self) -> HyperlaneDomainProtocol {
        use KnownHyperlaneDomain::*;
        match self {
            Injective
            | Neutron
            | Osmosis
            | Stride
            // Local chains
            | CosmosTest99990
            | CosmosTest99991 => HyperlaneDomainProtocol::Cosmos,
            CelestiaTestnet
            | CosmosTestNative1
            | CosmosTestNative2
            | Kyve
            | KyveAlpha
            | KyveTestnet
            | Milkyway
            | MilkywayTestnet
            | Noble
            | NobleTestnet
             => HyperlaneDomainProtocol::CosmosNative,
            EclipseMainnet
            | EclipseTestnet
            | SolanaMainnet
            | SolanaTestnet
            | Solaxy
            | SonicSvm
            | SonicSvmTestnet
            | Soon
            | SvmBnb
            // Local chains
            | SealevelTest1
            | SealevelTest2 => HyperlaneDomainProtocol::Sealevel,
            FuelTest1 => HyperlaneDomainProtocol::Fuel,
            Starknet
            | StarknetMainnet
            | StarknetSepolia
            | StarknetTest23448593
            | StarknetTest23448594
            | Paradex
            | ParadexSepolia
            | PragmaDevnet => HyperlaneDomainProtocol::Starknet,
            Radix | RadixTestnet => HyperlaneDomainProtocol::Radix,
            _ => HyperlaneDomainProtocol::Ethereum
        }
    }

    pub const fn domain_technical_stack(self) -> HyperlaneDomainTechnicalStack {
        use KnownHyperlaneDomain::*;
        match self {
            ApeChain | AppChain | Arbitrum | ArbitrumNova | ArbitrumSepolia | CarrchainTestnet
            | Cheesechain | Corn | Everclear | Fluence | DegenChain | Galactica | Gravity
            | InEvm | MiracleChain | Molten | Plume | PlumeTestnet | ProofOfPlay | Rarichain
            | SuperpositionMainnet | Xai => HyperlaneDomainTechnicalStack::ArbitrumNitro,
            Ancient8 | Base | Blast | Bob | Boba | B3 | Celo | Cyber | Form | Fraxtal | Guru
            | Ink | Lisk | MantaPacific | Mantle | Matchain | Metal | Metis | Mint | Mode
            | ModeTestnet | OpBnb | Optimism | Orderly | PolynomialFi | Redstone | Soneium
            | Superseed | Swell | Unichain | Worldchain | Zircuit | ZoraMainnet => {
                HyperlaneDomainTechnicalStack::OpStack
            }
            DogeChain | LumiaPrism | Katana | Merlin | PolygonZkEvm | Prom | Xlayer => {
                HyperlaneDomainTechnicalStack::PolygonCDK
            }
            Astar | Moonbeam | Peaq | Tangle | Torus => {
                HyperlaneDomainTechnicalStack::PolkadotSubstrate
            }
            StarknetMainnet | StarknetTest23448593 | StarknetTest23448594 | PragmaDevnet => {
                HyperlaneDomainTechnicalStack::Starknet
            }
            Abstract | Sophon | Treasure | Zeronetwork | Zksync => {
                HyperlaneDomainTechnicalStack::ZkSync
            }
            _ => HyperlaneDomainTechnicalStack::Other,
        }
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
        match protocol {
            Ethereum | Cosmos | CosmosNative | Starknet | Sovereign => IndexMode::Block,
            Fuel | Sealevel | Radix => IndexMode::Sequence,
        }
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
    use std::{collections::HashMap, num::NonZeroU32, str::FromStr};

    use serde::{Deserialize, Serialize};

    use crate::{
        HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack, HyperlaneDomainType,
        KnownHyperlaneDomain, ReorgPeriod, SubmitterType,
    };

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

    const MAINNET_CONFIG_JSON: &str = include_str!("../../config/mainnet_config.json");
    const TESTNET_CONFIG_JSON: &str = include_str!("../../config/testnet_config.json");

    #[derive(Clone, Debug, Deserialize, Serialize)]
    struct ChainConfig {
        #[serde(rename = "domainId")]
        pub domain_id: u32,
        pub protocol: String,
        #[serde(rename = "technicalStack")]
        pub technical_stack: Option<String>,
    }

    #[derive(Clone, Debug, Deserialize, Serialize)]
    struct ChainsConfig {
        pub chains: HashMap<String, ChainConfig>,
    }

    fn match_domain_id(chain_name: &str, expected_domain_id: u32, actual_domain_id: u32) {
        if expected_domain_id != actual_domain_id {
            panic!(
                "Incorrect domain id for `{chain_name}`.\nExpected `{}`, got `{}`",
                expected_domain_id, actual_domain_id
            )
        }
    }
    fn match_domain_type(
        chain_name: &str,
        expected_domain_type: HyperlaneDomainType,
        actual_domain_type: HyperlaneDomainType,
    ) {
        if expected_domain_type != actual_domain_type {
            panic!(
                "Incorrect domain type for `{chain_name}`.\nExpected `{}`, got `{}`",
                expected_domain_type, actual_domain_type
            )
        }
    }

    fn match_domain_protocol(
        chain_name: &str,
        protocol_str: &str,
        protocol: HyperlaneDomainProtocol,
    ) {
        match (protocol_str, protocol) {
            ("cosmos", HyperlaneDomainProtocol::Cosmos) => {}
            ("cosmosnative", HyperlaneDomainProtocol::CosmosNative) => {}
            ("ethereum", HyperlaneDomainProtocol::Ethereum) => {}
            ("sealevel", HyperlaneDomainProtocol::Sealevel) => {}
            ("sovereign", HyperlaneDomainProtocol::Sovereign) => {}
            ("starknet", HyperlaneDomainProtocol::Starknet) => {}
            _ => {
                panic!(
                    "Incorrect protocol config for `{chain_name}`.\nExpected `{}`, got `{}`",
                    protocol_str, protocol
                );
            }
        }
    }

    fn match_domain_stack(
        chain_name: &str,
        protocol_str: &str,
        protocol: HyperlaneDomainTechnicalStack,
    ) {
        match (protocol_str, protocol) {
            ("arbitrumnitro", HyperlaneDomainTechnicalStack::ArbitrumNitro) => {}
            ("opstack", HyperlaneDomainTechnicalStack::OpStack) => {}
            ("other", HyperlaneDomainTechnicalStack::Other) => {}
            ("polkadotsubstrate", HyperlaneDomainTechnicalStack::PolkadotSubstrate) => {}
            ("polygoncdk", HyperlaneDomainTechnicalStack::PolygonCDK) => {}
            ("starknet", HyperlaneDomainTechnicalStack::Starknet) => {}
            ("zksync", HyperlaneDomainTechnicalStack::ZkSync) => {}
            _ => {
                panic!(
                    "Incorrect domain stack for `{chain_name}`.\nExpected `{}`, got `{}`",
                    protocol_str, protocol
                );
            }
        }
    }

    /// test whether all chains in mainnet_config.json and testnet_config.json
    /// are accounted for in KnownHyperlaneDomain.
    #[ignore]
    #[test]
    fn config_matches_enums() {
        let mainnet_chains: ChainsConfig =
            serde_json::from_str(MAINNET_CONFIG_JSON).expect("Failed to parse mainnet_config.json");
        for (chain, chain_config) in mainnet_chains.chains {
            let domain = KnownHyperlaneDomain::from_str(&chain)
                .expect(&format!("Missing KnownHyperlaneDomain for {chain}"));

            match_domain_id(&chain, chain_config.domain_id, domain as u32);
            match_domain_type(&chain, HyperlaneDomainType::Mainnet, domain.domain_type());
            match_domain_protocol(
                &chain,
                chain_config.protocol.as_str(),
                domain.domain_protocol(),
            );
            if let Some(stack) = chain_config.technical_stack {
                match_domain_stack(&chain, stack.as_str(), domain.domain_technical_stack());
            } else {
                if domain.domain_technical_stack() != HyperlaneDomainTechnicalStack::Other {
                    panic!(
                        "Missing domain stack for `{chain}`.\nExpected `{}`, got `{}`",
                        HyperlaneDomainTechnicalStack::Other,
                        domain.domain_technical_stack()
                    );
                }
            }
        }

        let testnet_chains: ChainsConfig =
            serde_json::from_str(TESTNET_CONFIG_JSON).expect("Failed to parse testnet_config.json");

        for (chain, chain_config) in testnet_chains.chains {
            let domain = KnownHyperlaneDomain::from_str(&chain)
                .expect(&format!("Missing KnownHyperlaneDomain for {chain}"));

            match_domain_id(&chain, chain_config.domain_id, domain as u32);

            let domain_type = domain.domain_type();
            if domain_type != HyperlaneDomainType::Testnet
                && domain_type != HyperlaneDomainType::LocalTestChain
            {
                panic!(
                    "Incorrect domain type for `{chain}`.\nExpected Testnet or LocalTestChain, got `{}`",
                    domain_type
                );
            }

            match_domain_protocol(
                &chain,
                chain_config.protocol.as_str(),
                domain.domain_protocol(),
            );
            if let Some(stack) = chain_config.technical_stack {
                match_domain_stack(&chain, stack.as_str(), domain.domain_technical_stack());
            } else {
                if domain.domain_technical_stack() != HyperlaneDomainTechnicalStack::Other {
                    panic!(
                        "Missing domain stack for `{chain}`.\nExpected `{}`, got `{}`",
                        HyperlaneDomainTechnicalStack::Other,
                        domain.domain_technical_stack()
                    );
                }
            }
        }
    }
}
