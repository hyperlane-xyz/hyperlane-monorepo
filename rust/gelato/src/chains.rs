// Ideally we would avoid duplicating ethers::types::Chain, but we
// have enough need to justify a separate, more complete type
// conversion setup, including some helpers for e.g. locating
// Gelato's verifying contracts. Converting from the chain's name
// in string format is useful for CLI usage so that we don't
// have to remember chain IDs and can instead refer to names.

use ethers::types::{Address, U256};
use std::{fmt, str::FromStr};

use crate::err::GelatoError;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum Chain {
    Mainnet,
    Ropsten,
    Rinkeby,
    Goerli,
    Kovan,
    XDai,
    Polygon,
    PolygonMumbai,
    Avalanche,
    AvalancheFuji,
    Sepolia,
    Moonbeam,
    MoonbeamDev,
    Moonriver,
}

impl fmt::Display for Chain {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        write!(formatter, "{:?}", self)
    }
}

impl FromStr for Chain {
    type Err = GelatoError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "mainnet" => Ok(Chain::Mainnet),
            "ropsten" => Ok(Chain::Ropsten),
            "rinkeby" => Ok(Chain::Rinkeby),
            "goerli" => Ok(Chain::Goerli),
            "kovan" => Ok(Chain::Kovan),
            "xdai" => Ok(Chain::XDai),
            "polygon" => Ok(Chain::Polygon),
            "polygonmumbai" => Ok(Chain::PolygonMumbai),
            "avalanche" => Ok(Chain::Avalanche),
            "avalanchefuji" => Ok(Chain::AvalancheFuji),
            "sepolia" => Ok(Chain::Sepolia),
            "moonbeam" => Ok(Chain::Moonbeam),
            "moonbeamd" => Ok(Chain::MoonbeamDev),
            "moonriver" => Ok(Chain::Moonriver),
            _ => Err(GelatoError::UnknownChainNameError(String::from(s))),
        }
    }
}

impl From<Chain> for u32 {
    fn from(chain: Chain) -> Self {
        match chain {
            Chain::Mainnet => 1,
            Chain::Ropsten => 3,
            Chain::Rinkeby => 4,
            Chain::Goerli => 5,
            Chain::Kovan => 42,
            Chain::XDai => 100,
            Chain::Polygon => 137,
            Chain::PolygonMumbai => 80001,
            Chain::Avalanche => 43114,
            Chain::AvalancheFuji => 43113,
            Chain::Sepolia => 11155111,
            Chain::Moonbeam => 1287,
            Chain::MoonbeamDev => 1281,
            Chain::Moonriver => 1285,
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
    // We also have to provide hardcoded verification contract addresses
    // for Gelato-suppored chains, until a better / dynamic approach
    // becomes available.
    //
    // See `getRelayForwarderAddrss()` in the SDK file
    // `@gelatonetwork/gelato-relay-sdk/package/dist/constants/index.js`.
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
            Chain::XDai => Ok(Address::from_str(
                "eeea839E2435873adA11d5dD4CAE6032742C0445",
            )?),
            Chain::Polygon => Ok(Address::from_str(
                "c2336e796F77E4E57b6630b6dEdb01f5EE82383e",
            )?),
            Chain::PolygonMumbai => Ok(Address::from_str(
                "3428E19A01E40333D5D51465A08476b8F61B86f3",
            )?),
            _ => Err(GelatoError::UnknownRelayForwardAddress(*self)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names() {
        // FromStr provides both 'from_str' and a str.parse() implementation.
        assert_eq!(Chain::from_str("MAINNET").unwrap(), Chain::Mainnet);
        assert_eq!("MAINNET".parse::<Chain>().unwrap(), Chain::Mainnet);
        // Conversions are case insensitive.
        assert_eq!("XdAi".parse::<Chain>().unwrap(), Chain::XDai);
        // Error for unknown names.
        assert!("notChain".parse::<Chain>().is_err());
    }
    #[test]
    fn contracts() {
        assert!(!Chain::Mainnet.relay_fwd_addr().is_ok());
        assert!(Chain::Rinkeby.relay_fwd_addr().is_ok());
        assert!(Chain::Goerli.relay_fwd_addr().is_ok());
        assert!(Chain::Kovan.relay_fwd_addr().is_ok());
        assert!(Chain::XDai.relay_fwd_addr().is_ok());
        assert!(Chain::Polygon.relay_fwd_addr().is_ok());
        assert!(Chain::PolygonMumbai.relay_fwd_addr().is_ok());
    }
}
