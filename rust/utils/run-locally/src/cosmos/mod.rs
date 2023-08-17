use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use macro_rules_attribute::apply;
use tempfile::tempdir;

mod cli;
mod parse;
mod rpc;
mod utils;

use rpc::*;
use utils::*;

use crate::logging::log;
use crate::utils::{as_task, concat_path, AgentHandles, TaskHandle};
use cli::{OsmosisCLI, OsmosisEndpoint};

const OSMOSIS_CLI_GIT: &str = "https://github.com/osmosis-labs/osmosis";
const OSMOSIS_CLI_VERSION: &str = "16.1.1";

const KEY_VALIDATOR: &str = "legend auto stand worry powder idle recall there wet ancient universe badge ability blame hidden body steak april boost thrive room piece city type";
const KEY_ACCOUNTS1: &str = "stomach employ hidden risk fork parent dream noodle inside banner stable private grain nothing absent brave metal math hybrid amused move affair move muffin";
const KEY_ACCOUNTS2: &str = "say merry worry steak hedgehog sing spike fold empower pluck feel grass omit finish biology traffic dog sea ozone hint region service one gown";
const KEY_ACCOUNTS3: &str = "maple often cargo polar eager jaguar eight inflict once nest nice swamp weasel address swift physical valid culture cheese trumpet find dinosaur curve tray";

const CW_HYPERLANE_GIT: &str = "https://github.com/many-things/cw-hyperlane";
const CW_HYPERLANE_VERSION: &str = "0.0.1";

pub fn install_cli(dir: Option<PathBuf>) -> PathBuf {
    let target = {
        let os = if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            panic!("Current os is not supported by Osmosis")
        };

        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "amd64"
        };

        format!("{}-{}", os, arch)
    };

    let dir_path = match dir {
        Some(path) => path,
        None => tempdir().unwrap().into_path(),
    };
    let dir_path = dir_path.to_str().unwrap();

    let release_name = format!("osmosisd-{OSMOSIS_CLI_VERSION}-{target}");
    let release_comp = format!("{release_name}.tar.gz");

    log!("Downloading Osmosis CLI v{}", OSMOSIS_CLI_VERSION);
    let uri = format!("{OSMOSIS_CLI_GIT}/releases/download/v{OSMOSIS_CLI_VERSION}/{release_comp}");
    download(&release_comp, &uri, dir_path);

    log!("Uncompressing Osmosis release");
    unzip(&release_comp, dir_path);

    concat_path(dir_path, "osmosisd")
}

pub fn install_codes(dir: Option<PathBuf>) -> BTreeMap<String, PathBuf> {
    let dir_path = match dir {
        Some(path) => path,
        None => tempdir().unwrap().into_path(),
    };
    let dir_path = dir_path.to_str().unwrap();

    let release_name = format!("cw-hyperlane-v{CW_HYPERLANE_VERSION}");
    let release_comp = format!("{release_name}.tar.gz");

    log!("Downloading cw-hyperlane v{}", CW_HYPERLANE_VERSION);
    let uri = format!("{CW_HYPERLANE_GIT}/releases/download/{CW_HYPERLANE_VERSION}/{release_comp}");
    download(&release_comp, &uri, dir_path);

    log!("Uncompressing cw-hyperlane release");
    unzip(&release_comp, dir_path);

    // make contract_name => path map
    fs::read_dir(dir_path)
        .unwrap()
        .map(|v| {
            let entry = v.unwrap();
            (entry.file_name().into_string().unwrap(), entry.path())
        })
        .filter(|(filename, _)| filename.ends_with(".wasm"))
        .map(|v| (v.0.replace(".wasm", ""), v.1))
        .collect()
}

#[allow(dead_code)]
pub fn install_cosmos(
    cli_dir: Option<PathBuf>,
    codes_dir: Option<PathBuf>,
) -> (PathBuf, BTreeMap<String, PathBuf>) {
    let osmosisd = install_cli(cli_dir);
    let codes = install_codes(codes_dir);

    (osmosisd, codes)
}

#[derive(Clone)]
struct CosmosInitConfig {
    pub cli_path: PathBuf,
    pub home_path: Option<PathBuf>,

    pub codes: BTreeMap<String, PathBuf>,

    pub node_addr_base: String,
    pub node_port_base: u32,

    pub moniker: String,
    pub chain_id: String,
}

#[allow(dead_code)]
#[apply(as_task)]
fn launch_cosmos_validator(
    config: CosmosInitConfig,
) -> (
    AgentHandles,
    OsmosisEndpoint,
    BTreeMap<String, u64>,
    PathBuf,
) {
    let home_path = match config.home_path {
        Some(v) => v,
        None => tempdir().unwrap().into_path(),
    };

    let cli = OsmosisCLI::new(config.cli_path, home_path.to_str().unwrap());

    cli.init(&config.moniker, &config.chain_id);

    let (node, endpoint, stored_codes) = cli
        .run(config.node_addr_base, config.node_port_base, config.codes)
        .join();

    (node, endpoint, stored_codes, home_path)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_run() {
        let test_dir = tempdir().unwrap().into_path();
        let _ = fs::remove_dir_all(&test_dir);

        let test_cli_dir = concat_path(&test_dir, "cli");
        let test_codes_dir = concat_path(&test_dir, "codes");
        let test_node1_home = concat_path(&test_dir, "node1");
        let test_node2_home = concat_path(&test_dir, "node2");

        for path in [
            &test_dir,
            &test_cli_dir,
            &test_codes_dir,
            &test_node1_home,
            &test_node2_home,
        ] {
            fs::create_dir_all(path).unwrap();
        }

        let (osmosisd, codes) = install_cosmos(Some(test_cli_dir), Some(test_codes_dir));

        let addr_base = "tcp://0.0.0.0";
        let default_config = CosmosInitConfig {
            cli_path: osmosisd.clone(),
            home_path: None,

            codes,

            node_addr_base: addr_base.to_string(),
            node_port_base: 26657,

            moniker: "localnet".to_string(),
            chain_id: "local-node".to_string(),
        };

        let launch_node1_res = launch_cosmos_validator(CosmosInitConfig {
            home_path: Some(test_node1_home),
            node_port_base: 26600,
            chain_id: "local-node-1".to_string(),
            ..default_config.clone()
        });

        let launch_node2_res = launch_cosmos_validator(CosmosInitConfig {
            home_path: Some(test_node2_home),
            node_port_base: 26610,
            chain_id: "local-node-2".to_string(),
            ..default_config.clone()
        });

        let (_, _, node1_codes, ..) = launch_node1_res.join();
        let (_, _, node2_codes, ..) = launch_node2_res.join();

        println!("node1 codes: {:?}", node1_codes);
        println!("node2 codes: {:?}", node2_codes);
    }
}
