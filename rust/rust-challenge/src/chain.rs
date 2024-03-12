// Note: this is less than an ideal solution for the following reasons:
// - If I were to to do this properly I'd like to do this with some type of json configuration file
//    instead of hardcoding the values
// - This makes the RPC url non-configurable from the command line
use std::str::FromStr;

use url::Url;

// TODO: Implement more chains
/// Supported chains for Rust Challenge
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chain {
    /// Sepolia chain
    Sepolia,
    /// Mumbai chain
    Mumbai,
}

// TODO: this is just leaking my rpc urls, so that's got to be replaced with a configuration file
impl Chain {
    /// Returns the RPC URL for the chain
    pub fn rpc_url(&self) -> Url {
        match self {
            // Note: the unwrap is safe here because the URLs are hardcoded and are guaranteed to be valid
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

#[derive(Debug, thiserror::Error)]
pub enum ChainError {
    #[error("unsupported chain: {0}")]
    UnsupportedChain(String),
}
