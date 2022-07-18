// Ideally we would avoid duplicating ethers::types::Chain, but we have enough need to justify
// a separate, more complete type conversion setup, including some helpers for e.g. locating
// Gelato's verifying contracts.

use ethers::types::{Address, U256};
use std::str::FromStr;

use crate::err::GelatoError;

// This list is currently trimmed to the *intersection* of
// {chains used by Abacus in any environment} and {chains included in ethers::types::Chain}.
// Notably missing is Celo/Alfajores.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Chain {
    Mainnet = 1,
    Rinkeby = 4,
    Goerli = 5,
    Kovan = 42,
    Polygon = 137,
    PolygonMumbai = 80001,
    Avalanche = 43114,
    AvalancheFuji = 43113,
    Arbitrum = 42161,
    ArbitrumTestnet = 421611,
    Optimism = 10,
    OptimismKovan = 69,
    BinanceSmartChain = 56,
    BinanceSmartChainTestnet = 97,
}

#[derive(Clone, Debug)]
// Newtype to represent the chain's ID.
pub struct ChainID(u32);
impl From<u32> for ChainID {
    fn from(id: u32) -> Self {
        ChainID(id)
    }
}
impl From<ChainID> for u32 {
    fn from(id: ChainID) -> Self {
        id.0
    }
}
impl std::fmt::Display for ChainID {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl Chain {
    pub fn chain_id(&self) -> ChainID {
        match self {
            Chain::Mainnet => 1,
            Chain::Rinkeby => 4,
            Chain::Goerli => 5,
            Chain::Kovan => 42,
            Chain::Polygon => 137,
            Chain::PolygonMumbai => 80001,
            Chain::Avalanche => 43114,
            Chain::AvalancheFuji => 43113,
            Chain::Arbitrum => 42161,
            Chain::ArbitrumTestnet => 421611,
            Chain::Optimism => 10,
            Chain::OptimismKovan => 69,
            Chain::BinanceSmartChain => 56,
            Chain::BinanceSmartChainTestnet => 97,
        }
        .into()
    }
}

impl std::fmt::Display for Chain {
    fn fmt(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        let chain_display_name = match self {
            Chain::Mainnet => "Mainnet",
            Chain::Rinkeby => "Rinkeby",
            Chain::Goerli => "Goerli",
            Chain::Kovan => "Kovan",
            Chain::Polygon => "Polygon",
            Chain::PolygonMumbai => "Polygon Mumbai",
            Chain::Avalanche => "Avalanche",
            Chain::AvalancheFuji => "Avalanche Fuji",
            Chain::Arbitrum => "Arbitrum",
            Chain::ArbitrumTestnet => "Arbitrum Testnet",
            Chain::Optimism => "Optimism",
            Chain::OptimismKovan => "Optimism Kovan",
            Chain::BinanceSmartChain => "Binance Smart Chain",
            Chain::BinanceSmartChainTestnet => "Binance Smart Chain Testnet",
        };
        write!(
            formatter,
            "{:?} (id: {})",
            chain_display_name,
            self.chain_id()
        )
    }
}

impl From<Chain> for u32 {
    fn from(chain: Chain) -> Self {
        match chain {
            Chain::Mainnet => 1,
            Chain::Rinkeby => 4,
            Chain::Goerli => 5,
            Chain::Kovan => 42,
            Chain::Polygon => 137,
            Chain::PolygonMumbai => 80001,
            Chain::Avalanche => 43114,
            Chain::AvalancheFuji => 43113,
            Chain::Arbitrum => 42161,
            Chain::ArbitrumTestnet => 421611,
            Chain::Optimism => 10,
            Chain::OptimismKovan => 69,
            Chain::BinanceSmartChain => 56,
            Chain::BinanceSmartChainTestnet => 97,
        }
    }
}

impl From<Chain> for U256 {
    fn from(chain: Chain) -> Self {
        u32::from(chain).into()
    }
}

impl From<Chain> for u64 {
    fn from(chain: Chain) -> Self {
        u32::from(chain).into()
    }
}

impl Chain {
    // We also have to provide hardcoded verification contract addresses for Gelato-suppored
    // chains, until a better / dynamic approach becomes available. See
    // `getRelayForwarderAddrss()` in the SDK file
    // https://github.com/gelatodigital/relay-sdk/blob/master/src/constants/index.ts.
    pub fn relay_fwd_addr(&self) -> Result<Address, GelatoError> {
        match self {
            Chain::Rinkeby => Ok(Address::from_str(
                "9B79b798563e538cc326D03696B3Be38b971D282",
            )?),
            Chain::Goerli => Ok(Address::from_str(
                "61BF11e6641C289d4DA1D59dC3E03E15D2BA971c",
            )?),
            Chain::Kovan => Ok(Address::from_str(
                "4F36f93F58d36DcbC1E60b9bdBE213482285C482",
            )?),
            Chain::Polygon => Ok(Address::from_str(
                "c2336e796F77E4E57b6630b6dEdb01f5EE82383e",
            )?),
            Chain::PolygonMumbai => Ok(Address::from_str(
                "3428E19A01E40333D5D51465A08476b8F61B86f3",
            )?),
            Chain::BinanceSmartChain => Ok(Address::from_str(
                "247A1306b6122ba28862b19a95004899db91f1b5",
            )?),
            _ => Err(GelatoError::UnknownRelayForwardAddress(*self)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contracts() {
        assert!(!Chain::Mainnet.relay_fwd_addr().is_ok());
        assert!(Chain::Rinkeby.relay_fwd_addr().is_ok());
        assert!(Chain::Goerli.relay_fwd_addr().is_ok());
        assert!(Chain::Kovan.relay_fwd_addr().is_ok());
        assert!(Chain::Polygon.relay_fwd_addr().is_ok());
        assert!(Chain::PolygonMumbai.relay_fwd_addr().is_ok());
    }

    #[test]
    fn display() {
        assert_eq!(
            format!("{}", Chain::PolygonMumbai),
            r#""Polygon Mumbai" (id: 80001)"#
        );
    }
}
