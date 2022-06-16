#![allow(missing_docs)]

use eyre::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Address(pub bytes::Bytes);

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Balance(pub num::BigInt);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractLocator {
    pub chain_name: String,
    pub domain: u32,
    pub address: Address,
}
impl std::fmt::Display for ContractLocator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}[@{}]+contract:0x{:x}",
            self.chain_name, self.domain, self.address.0
        )
    }
}

#[async_trait::async_trait]
pub trait Chain {
    /// Query the balance on a chain
    async fn query_balance(&self, addr: Address) -> Result<Balance>;
}

impl From<Address> for ethers::types::H160 {
    fn from(addr: Address) -> Self {
        ethers::types::H160::from_slice(addr.0.as_ref())
    }
}

impl From<ethers::types::H160> for Address {
    fn from(addr: ethers::types::H160) -> Self {
        Address(bytes::Bytes::from(addr.as_bytes().to_owned()))
    }
}

impl From<&'_ Address> for ethers::types::H160 {
    fn from(addr: &Address) -> Self {
        ethers::types::H160::from_slice(addr.0.as_ref())
    }
}

/// Quick single-use macro to prevent typing domain and chain twice and risking inconsistencies.
macro_rules! domain_and_chain {
    {$($domain:literal <=> $chain:literal,)*} => {
        /// Get the chain name from a domain id. Returns `None` if the `domain` is unknown.
        pub fn chain_from_domain(domain: u32) -> Option<&'static str> {
            match domain {
                $( $domain => Some($chain), )*
                _ => None
            }
        }

        /// Get the domain id from a chain name. Expects `chain` to be a lowercase str.
        /// Returns `None` if the `chain` is unknown.
        pub fn domain_from_chain(chain: &str) -> Option<u32> {
            match chain {
                $( $chain => Some($domain), )*
                _ => None
            }
        }
    }
}

// Copied from https://github.com/abacus-network/abacus-monorepo/blob/54a41d5a4bbb86a3b08d02d7ff6662478c41e221/typescript/sdk/src/chain-metadata.ts
domain_and_chain! {
    0x63656c6f <=> "celo",
    0x657468 <=> "ethereum",
    0x61766178 <=> "avalanche",
    0x706f6c79 <=> "polygon",
    1000 <=> "alfajores",
    43113 <=> "fuji",
    5 <=> "goerli",
    3000 <=> "kovan",
    80001 <=> "mumbai",
    13371 <=> "test1",
    13372 <=> "test2",
    13373 <=> "test3",
    0x62732d74 <=> "bsctestnet",
    0x61722d72 <=> "arbitrumrinkeby",
    0x6f702d6b <=> "optimismkovan",
    0x61752d74 <=> "auroratestnet",
}
