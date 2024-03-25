/*
* This is a placeholder solution in lieue of configurable chain selection.
* If I had more time I'd probably implement a yaml config file that would allow
* users to specify Rpc URL, Chain ID, and Chain Name / cli to ship configurable defaults.
*/
use std::fmt::{self, Display, Formatter};
use std::str::FromStr;

use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chain {
    /// Sepolia chain
    Sepolia,
    /// Mumbai chain
    Mumbai,
    // TODO: Add more chains
}

impl Chain {
    /// Returns the RPC URL for the chain
    pub fn rpc_url(&self) -> Url {
        match self {
            // Unwraps are safe :thumbsup:
            Chain::Sepolia => {
                Url::parse("https://sepolia.infura.io/v3/1888a8bd8f90419aaaf008f44525c9b7").unwrap()
            }
            Chain::Mumbai => {
                Url::parse("https://polygon-mumbai.infura.io/v3/1888a8bd8f90419aaaf008f44525c9b7")
                    .unwrap()
            }
        }
    }

    /// Returns the chain ID for the chain
    pub fn chain_id(&self) -> u32 {
        match self {
            Chain::Sepolia => 11155111,
            Chain::Mumbai => 80001,
        }
    }
}

impl FromStr for Chain {
    type Err = ChainError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "sepolia" => Ok(Chain::Sepolia),
            "mumbai" => Ok(Chain::Mumbai),
            _ => Err(ChainError::UnsupportedChain(s.to_string())),
        }
    }
}

impl Display for Chain {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        match self {
            Chain::Sepolia => write!(f, "sepolia"),
            Chain::Mumbai => write!(f, "mumbai"),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ChainError {
    #[error("unsupported chain: {0}")]
    UnsupportedChain(String),
}
