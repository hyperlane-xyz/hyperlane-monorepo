// Ideally we would avoid duplicating ethers::types::Chain, but ethers::types::Chain doesn't
// include all chains we support.
use ethers::types::U256;
use serde::{Serialize, Serializer};
use serde_repr::Serialize_repr;
use std::fmt;

// Each chain and chain ID supported by Abacus
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize_repr, std::hash::Hash)]
#[repr(u64)]
pub enum Chain {
    Ethereum = 1,
    Rinkeby = 4,
    Goerli = 5,
    Kovan = 42,

    Polygon = 137,
    Mumbai = 80001,

    Avalanche = 43114,
    Fuji = 43113,

    Arbitrum = 42161,
    ArbitrumRinkeby = 421611,

    Optimism = 10,
    OptimismKovan = 69,

    BinanceSmartChain = 56,
    BinanceSmartChainTestnet = 97,

    Celo = 42220,
    Alfajores = 44787,

    MoonbaseAlpha = 1287,
}

impl fmt::Display for Chain {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        write!(formatter, "{:?}", self)
    }
}

impl From<Chain> for u32 {
    fn from(chain: Chain) -> Self {
        chain as u32
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

pub fn serialize_as_decimal_str<S>(maybe_n: &Option<U256>, s: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if let Some(n) = maybe_n {
        return s.serialize_str(&format!("{}", n));
    }
    maybe_n.serialize(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u32_from_chain() {
        assert_eq!(u32::from(Chain::Ethereum), 1);
        assert_eq!(u32::from(Chain::Celo), 42220);
    }
}
