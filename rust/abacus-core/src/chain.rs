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

/// Quick single-use macro to prevent typing domain and chain twice and risking
/// inconsistencies.
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

// The unit test in this file `tests::json_mappings_match_code_map`
// tries to ensure some stability between the {chain} X {domain}
// mapping below with the agent configuration file.
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
    6386274 <=> "arbitrum",
    6452067 <=> "bsc",
    28528 <=> "optimism",
    13371 <=> "test1",
    13372 <=> "test2",
    13373 <=> "test3",
    0x62732d74 <=> "bsctestnet",
    0x61722d72 <=> "arbitrumrinkeby",
    0x6f702d6b <=> "optimismkovan",
    0x61752d74 <=> "auroratestnet",
    0x6d6f2d61 <=> "moonbasealpha",
}

#[cfg(test)]
mod tests {
    use abacus_base::Settings;
    use config::{Config, File, FileFormat};
    use num_traits::identities::Zero;
    use std::collections::BTreeSet;
    use std::fs::read_to_string;
    use std::path::Path;
    use walkdir::WalkDir;

    /// Relative path to the `abacus-monorepo/rust/config/`
    /// directory, which is where the agent's config files
    /// currently live.
    const AGENT_CONFIG_PATH_ROOT: &str = "../config";

    /// We will not include any file paths of config/settings files
    /// in the test suite if *any* substring of the file path matches
    /// against one of the strings included in the blacklist below.
    /// This is to ensure that e.g. when a backwards-incompatible
    /// change is made in config file format, and agents can't parse
    /// them anymore, we don't fail the test. (E.g. agents cannot
    /// currently parse the older files in `config/dev/` or
    /// `config/testnet`.
    const BLACKLISTED_DIRS: &[&str] = &[
        // Ignore only-local names of fake chains used by
        // e.g. test suites.
        "test/test1_config.json",
        "test/test2_config.json",
        "test/test3_config.json",
    ];

    fn is_blacklisted(path: &Path) -> bool {
        BLACKLISTED_DIRS
            .iter()
            .any(|x| path.to_str().unwrap().contains(x))
    }

    #[derive(Clone, Debug, Ord, PartialEq, PartialOrd, Eq, Hash)]
    struct ChainCoordinate {
        name: String,
        domain: u32,
    }

    fn config_paths(root: &Path) -> Vec<String> {
        WalkDir::new(root)
            .min_depth(2)
            .into_iter()
            .filter_map(|x| x.ok())
            .map(|x| x.into_path())
            .filter(|x| !is_blacklisted(x))
            .map(|x| x.into_os_string())
            .filter_map(|x| x.into_string().ok())
            .collect()
    }

    /// Provides a vector of parsed `abacus_base::Settings` objects
    /// built from all of the version-controlled agent configuration files.
    /// This is purely a utility to allow us to test a handful of critical
    /// properties related to those configs and shouldn't be used outside
    /// of a test env. This test simply tries to do some sanity checks
    /// against the integrity of that data.
    fn abacus_settings() -> Vec<Settings> {
        let root = Path::new(AGENT_CONFIG_PATH_ROOT);
        let paths = config_paths(root);
        let files: Vec<String> = paths
            .iter()
            .filter_map(|x| read_to_string(x).ok())
            .collect();
        paths
            .iter()
            .zip(files.iter())
            .map(|(p, f)| {
                Config::builder()
                    .add_source(File::from_str(f.as_str(), FileFormat::Json))
                    .build()
                    .unwrap()
                    .try_deserialize()
                    .unwrap_or_else(|e| {
                        panic!("!cfg({}): {:?}: {}", p, e, f);
                    })
            })
            .collect()
    }

    fn outbox_chain_names() -> BTreeSet<String> {
        abacus_settings()
            .iter()
            .map(|x| x.outbox.name.clone())
            .collect()
    }

    fn inbox_chain_names() -> BTreeSet<String> {
        abacus_settings()
            .iter()
            .flat_map(|x: &Settings| x.inboxes.iter().map(|(k, _)| String::from(k)))
            .collect()
    }

    fn outbox_name_domain_coords() -> BTreeSet<ChainCoordinate> {
        abacus_settings()
            .iter()
            .map(|x| ChainCoordinate {
                name: x.outbox.name.clone(),
                domain: x.outbox.domain.parse().unwrap(),
            })
            .collect()
    }

    fn inbox_name_domain_records() -> BTreeSet<ChainCoordinate> {
        abacus_settings()
            .iter()
            .flat_map(|x: &Settings| {
                x.inboxes.iter().map(|(_, v)| ChainCoordinate {
                    name: v.name.clone(),
                    domain: v.domain.parse().unwrap(),
                })
            })
            .collect()
    }

    #[test]
    fn agent_json_config_consistency_checks() {
        // Inbox/outbox and chain-presence equality
        // (sanity checks that we have a complete list of
        // relevant chains).
        let inbox_chains = inbox_chain_names();
        let outbox_chains = outbox_chain_names();
        assert!(inbox_chains.symmetric_difference(&outbox_chains).count() == usize::zero());
        assert_eq!(&inbox_chains.len(), &outbox_chains.len());

        // Verify that the the outbox-associative chain-name
        // and domain-number records agree with the
        // inbox-associative chain-name and domain-number
        // records, since our configuration data is /not/
        // normalized and could drift out of sync.
        let inbox_coords = inbox_name_domain_records();
        let outbox_coords = outbox_name_domain_coords();
        assert!(inbox_coords.symmetric_difference(&outbox_coords).count() == usize::zero());
        assert_eq!(&inbox_coords.len(), &outbox_coords.len());

        // TODO(webbhorn): Also verify with this functionality
        // we have entries for all of the Gelato contract
        // addresses we need hardcoded in the binary for now.

        // Verify that the hard-coded, macro-maintained
        // mapping in `abacus-core/src/chain.rs` named
        // by the macro `domain_and_chain` is complete
        // and in agreement with our on-disk json-based
        // configuration data.
        for ChainCoordinate { name, domain } in inbox_coords.iter().chain(outbox_coords.iter()) {
            assert_eq!(
                super::chain_from_domain(domain.to_owned()).unwrap(),
                name.to_owned()
            );
            assert_eq!(super::domain_from_chain(name).unwrap(), domain.to_owned());
        }
    }
}
