use std::collections::BTreeSet;
use std::fs::read_to_string;
use std::path::Path;

use config::{Config, FileFormat};
use walkdir::WalkDir;

use hyperlane_base::{RawSettings, Settings};
use hyperlane_core::config::*;
use hyperlane_core::KnownHyperlaneDomain;

/// Relative path to the `hyperlane-monorepo/rust/config/`
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
    "test/test_config.json",
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

/// Provides a vector of parsed `hyperlane_base::Settings` objects
/// built from all of the version-controlled agent configuration files.
/// This is purely a utility to allow us to test a handful of critical
/// properties related to those configs and shouldn't be used outside
/// of a test env. This test simply tries to do some sanity checks
/// against the integrity of that data.
fn hyperlane_settings() -> Vec<Settings> {
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
            let raw: RawSettings = Config::builder()
                .add_source(config::File::from_str(f.as_str(), FileFormat::Json))
                .build()
                .unwrap()
                .try_deserialize::<RawSettings>()
                .unwrap_or_else(|e| {
                    panic!("!cfg({}): {:?}: {}", p, e, f);
                });
            Settings::from_config(raw, &ConfigPath::default()).unwrap()
        })
        .collect()
}

fn chain_name_domain_records() -> BTreeSet<ChainCoordinate> {
    hyperlane_settings()
        .iter()
        .flat_map(|x: &Settings| {
            x.chains.values().map(|v| ChainCoordinate {
                name: v.domain.name().into(),
                domain: (&v.domain).try_into().expect("Invalid domain id"),
            })
        })
        .collect()
}

#[test]
fn agent_json_config_consistency_checks() {
    // Verify that the hard-coded, macro-maintained
    // mapping in `hyperlane-core/src/chain.rs` named
    // by the macro `domain_and_chain` is complete
    // and in agreement with our on-disk json-based
    // configuration data.
    let chain_coords = chain_name_domain_records();
    for ChainCoordinate { name, domain } in chain_coords.into_iter() {
        assert_eq!(
            KnownHyperlaneDomain::try_from(domain).unwrap().to_string(),
            name
        );
        assert_eq!(
            name.parse::<KnownHyperlaneDomain>().unwrap() as u32,
            domain
        );
    }
}
