use std::{collections::BTreeSet, fs::read_to_string, path::Path};

use config::{Config, FileFormat};
use eyre::Context;
use hyperlane_base::settings::{parser::RawAgentConf, Settings};
use hyperlane_core::{config::*, KnownHyperlaneDomain};
use walkdir::WalkDir;

/// Relative path to the `hyperlane-monorepo/rust/main/config/`
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
    // Determine the config path based on the crate root so that
    // the debugger can also find the config file.
    let crate_root = env!("CARGO_MANIFEST_DIR");
    let config_path = format!("{crate_root}/{AGENT_CONFIG_PATH_ROOT}");
    let root = Path::new(config_path.as_str());
    let paths = config_paths(root);
    let files: Vec<String> = paths
        .iter()
        .filter_map(|x| read_to_string(x).ok())
        .collect();
    paths
        .iter()
        .zip(files.iter())
        // Filter out config files that can't be parsed as json (e.g. env files)
        .filter_map(|(p, f)| {
            let raw: RawAgentConf = Config::builder()
                .add_source(config::File::from_str(f.as_str(), FileFormat::Json))
                .build()
                .ok()?
                .try_deserialize::<RawAgentConf>()
                .unwrap_or_else(|e| {
                    panic!("!cfg({p}): {e:?}: {f}");
                });
            Settings::from_config(raw, &ConfigPath::default(), "mock_agent")
                .context("Config parsing error, please check the config reference (https://docs.hyperlane.xyz/docs/operators/agent-configuration/configuration-reference)")
                .ok()
        })
        .collect()
}

fn bundled_config(file_name: &str) -> serde_json::Value {
    let crate_root = env!("CARGO_MANIFEST_DIR");
    let path = format!("{crate_root}/{AGENT_CONFIG_PATH_ROOT}/{file_name}");
    let contents = read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read bundled config {path}: {error}"));
    serde_json::from_str(&contents)
        .unwrap_or_else(|error| panic!("failed to deserialize bundled config {path}: {error}"))
}

fn chain_name_domain_records() -> BTreeSet<ChainCoordinate> {
    hyperlane_settings()
        .iter()
        .flat_map(|x: &Settings| {
            x.chains.values().map(|v| ChainCoordinate {
                name: v.domain.name().into(),
                domain: (&v.domain).into(),
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
        assert_eq!(name.parse::<KnownHyperlaneDomain>().unwrap() as u32, domain);
    }
}

#[test]
fn canonical_solana_configs_enable_v1_reads() {
    let configs = [
        (bundled_config("mainnet_config.json"), "solanamainnet"),
        (bundled_config("testnet_config.json"), "solanatestnet"),
        (bundled_config("testnet_config.json"), "solanadevnet"),
    ];

    for (config, name) in configs {
        assert_eq!(
            config["chains"][name]["maxSupportedTransactionVersion"], 1,
            "{name} should accept Solana v1 JSON reads by default",
        );
    }
}
