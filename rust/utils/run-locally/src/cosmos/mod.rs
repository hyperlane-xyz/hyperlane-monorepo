use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

use hpl_interface::types::bech32_decode;
use macro_rules_attribute::apply;
use tempfile::tempdir;

mod cli;
mod crypto;
mod deploy;
mod link;
mod rpc;
mod types;
mod utils;

use rpc::*;
use types::*;
use utils::*;

use crate::cosmos::link::link_networks;
use crate::logging::log;
use crate::program::Program;
use crate::utils::{as_task, concat_path, stop_child, AgentHandles, TaskHandle};
use cli::{OsmosisCLI, OsmosisEndpoint};

use self::deploy::deploy_cw_hyperlane;

const OSMOSIS_CLI_GIT: &str = "https://github.com/osmosis-labs/osmosis";
const OSMOSIS_CLI_VERSION: &str = "16.1.1";

const KEY_HPL_VALIDATOR: (&str,&str) = ("hpl-validator", "guard evolve region sentence danger sort despair eye deputy brave trim actor left recipe debate document upgrade sustain bus cage afford half demand pigeon");
const KEY_HPL_RELAYER: (&str,&str) = ("hpl-relayer", "moral item damp melt gloom vendor notice head assume balance doctor retire fashion trim find biology saddle undo switch fault cattle toast drip empty");

const KEY_VALIDATOR: (&str,&str) = ("validator", "legend auto stand worry powder idle recall there wet ancient universe badge ability blame hidden body steak april boost thrive room piece city type");
const KEY_ACCOUNTS1: (&str,&str) = ("account1", "stomach employ hidden risk fork parent dream noodle inside banner stable private grain nothing absent brave metal math hybrid amused move affair move muffin");
const KEY_ACCOUNTS2: (&str,&str) = ("account2", "say merry worry steak hedgehog sing spike fold empower pluck feel grass omit finish biology traffic dog sea ozone hint region service one gown");
const KEY_ACCOUNTS3: (&str,&str) = ("account3", "maple often cargo polar eager jaguar eight inflict once nest nice swamp weasel address swift physical valid culture cheese trumpet find dinosaur curve tray");

fn default_keys<'a>() -> [(&'a str, &'a str); 6] {
    [
        KEY_HPL_VALIDATOR,
        KEY_HPL_RELAYER,
        KEY_VALIDATOR,
        KEY_ACCOUNTS1,
        KEY_ACCOUNTS2,
        KEY_ACCOUNTS3,
    ]
}

const CW_HYPERLANE_GIT: &str = "https://github.com/many-things/cw-hyperlane";
const CW_HYPERLANE_VERSION: &str = "0.0.2";

fn make_target() -> String {
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
}

pub fn install_cli(dir: Option<PathBuf>) -> PathBuf {
    let target = make_target();

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
    let uri =
        format!("{CW_HYPERLANE_GIT}/releases/download/v{CW_HYPERLANE_VERSION}/{release_comp}");
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
pub struct CosmosConfig {
    pub cli_path: PathBuf,
    pub home_path: Option<PathBuf>,

    pub codes: BTreeMap<String, PathBuf>,

    pub node_addr_base: String,
    pub node_port_base: u32,

    pub moniker: String,
    pub chain_id: String,
}

pub struct CosmosResp {
    pub node: AgentHandles,
    pub endpoint: OsmosisEndpoint,
    pub codes: Codes,
    pub home_path: PathBuf,
}

impl CosmosResp {
    pub fn cli(&self, bin: &Path) -> OsmosisCLI {
        OsmosisCLI::new(bin.to_path_buf(), self.home_path.to_str().unwrap())
    }
}

pub struct CosmosNetwork {
    pub launch_resp: CosmosResp,
    pub deployments: Deployments,
    pub chain_id: String,
    pub domain: u32,
}

impl Drop for CosmosNetwork {
    fn drop(&mut self) {
        stop_child(&mut self.launch_resp.node.1);
    }
}

impl From<(CosmosResp, Deployments, String, u32)> for CosmosNetwork {
    fn from(v: (CosmosResp, Deployments, String, u32)) -> Self {
        Self {
            launch_resp: v.0,
            deployments: v.1,
            chain_id: v.2,
            domain: v.3,
        }
    }
}

#[apply(as_task)]
fn launch_cosmos_node(config: CosmosConfig) -> CosmosResp {
    let home_path = match config.home_path {
        Some(v) => v,
        None => tempdir().unwrap().into_path(),
    };

    let cli = OsmosisCLI::new(config.cli_path, home_path.to_str().unwrap());

    cli.init(&config.moniker, &config.chain_id);

    let (node, endpoint) = cli.start(config.node_addr_base, config.node_port_base);
    let codes = cli.store_codes(&endpoint, "validator", config.codes);

    CosmosResp {
        node,
        endpoint,
        codes,
        home_path,
    }
}

#[apply(as_task)]
fn launch_cosmos_validator(
    agent_config: AgentConfig,
    agent_config_path: PathBuf,
    remotes: Vec<String>,
) -> AgentHandles {
    let validator_base = tempdir().unwrap();
    let validator_base_db = concat_path(&validator_base, "db");

    let checkpoint_path = concat_path(&validator_base, "checkpoint");
    let signature_path = concat_path(&validator_base, "signature");

    let validator = Program::new("cargo")
        .cmd("run")
        .arg("bin", "validator")
        .env("CONFIG_FILES", agent_config_path.to_str().unwrap())
        .env(
            "MY_VALIDATOR_SIGNATURE_DIRECTORY",
            signature_path.to_str().unwrap(),
        )
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHECKPOINTSYNCER_PATH", checkpoint_path.to_str().unwrap())
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage")
        .hyp_env("ORIGINCHAINNAME", agent_config.name)
        .hyp_env("RELAYCHAINS", remotes.join(","))
        .hyp_env("REORGPERIOD", "1")
        .hyp_env("VALIDATOR_KEY", agent_config.signer.key)
        .hyp_env("VALIDATOR_TYPE", agent_config.signer.typ)
        .hyp_env("DB", validator_base_db.to_str().unwrap())
        .hyp_env("VALIDATOR_PREFIX", "osmo1")
        .spawn("VAL");

    validator
}

#[apply(as_task)]
fn launch_cosmos_relayer(agent_config_path: PathBuf, relay_chains: Vec<String>) -> AgentHandles {
    let relayer_base = tempdir().unwrap();
    let relayer_base_db = concat_path(&relayer_base, "db");

    let relayer = Program::new("cargo")
        .cmd("run")
        .arg("--bin", "relayer")
        .env("CONFIG_FILES", agent_config_path.to_str().unwrap())
        .env("RUST_BACKTRACE", "1")
        .hyp_env("RELAYCHAINS", relay_chains.join(","))
        .hyp_env("REORGPERIOD", "1")
        .hyp_env("DB", relayer_base_db.to_str().unwrap())
        .spawn("RLY");

    relayer
}

#[allow(dead_code)]
fn run_locally() {
    let (osmosisd, codes) = install_cosmos(None, None);

    let addr_base = "tcp://0.0.0.0";
    let default_config = CosmosConfig {
        cli_path: osmosisd.clone(),
        home_path: None,

        codes,

        node_addr_base: addr_base.to_string(),
        node_port_base: 26657,

        moniker: "localnet".to_string(),
        chain_id: "local-node".to_string(),
    };

    let port_start = 26600u32;
    let domain_start = 26657u32;
    let node_count = 2;

    let nodes = (0..node_count)
        .map(|i| {
            (
                launch_cosmos_node(CosmosConfig {
                    node_port_base: port_start + (i * 10),
                    chain_id: format!("local-node-{}", i),
                    ..default_config.clone()
                }),
                format!("local-node-{}", i),
                domain_start + i,
            )
        })
        .collect::<Vec<_>>();

    let deployer = "validator";
    let linker = "validator";
    let validator = "hpl-validator";
    let relayer = "hpl-relayer";

    let nodes = nodes
        .into_iter()
        .map(|v| (v.0.join(), v.1, v.2))
        .map(|(launch_resp, chain_id, domain)| {
            let deployments = deploy_cw_hyperlane(
                launch_resp.cli(&osmosisd),
                launch_resp.endpoint.clone(),
                deployer.to_string(),
                launch_resp.codes.clone(),
                domain,
            );

            (launch_resp, deployments, chain_id, domain)
        })
        .collect::<Vec<_>>();

    // nodes with base deployments
    let nodes = nodes
        .into_iter()
        .map(|v| (v.0, v.1.join(), v.2, v.3))
        .map(|v| v.into())
        .collect::<Vec<CosmosNetwork>>();

    for (i, node) in nodes.iter().enumerate() {
        let targets = &nodes[(i + 1)..];

        if !targets.is_empty() {
            println!(
                "{} -> {:?}",
                node.domain,
                targets.iter().map(|v| v.domain).collect::<Vec<_>>()
            );
        }

        for target in targets {
            link_networks(&osmosisd, linker, validator, node, target);
        }
    }

    // for debug
    println!(
        "{}",
        serde_json::to_string(
            &nodes
                .iter()
                .map(|v| (v.domain, v.deployments.clone()))
                .collect::<BTreeMap<_, _>>()
        )
        .unwrap()
    );

    let config_dir = tempdir().unwrap();

    // export agent config
    let agent_config_out = AgentConfigOut {
        chains: nodes
            .iter()
            .map(|v| {
                (
                    v.chain_id.to_string(),
                    AgentConfig::new(osmosisd.clone(), validator, v),
                )
            })
            .collect::<BTreeMap<String, AgentConfig>>(),
    };

    let agent_config_path = concat_path(&config_dir, "config.json");
    fs::write(
        &agent_config_path,
        serde_json::to_string_pretty(&agent_config_out).unwrap(),
    )
    .unwrap();

    let hpl_val = agent_config_out
        .chains
        .clone()
        .into_iter()
        .map(|(chain_id, agent_config)| {
            let mut others = agent_config_out.chains.clone();
            others.remove(&chain_id);
            let remotes = others.into_iter().map(|v| v.0).collect::<Vec<_>>();

            launch_cosmos_validator(agent_config, agent_config_path.clone(), remotes)
        })
        .collect::<Vec<_>>();
    let hpl_val = hpl_val.into_iter().map(|v| v.join()).collect::<Vec<_>>();
    let mut hpl_rly = launch_cosmos_relayer(
        agent_config_path,
        agent_config_out.chains.into_keys().collect::<Vec<_>>(),
    )
    .join();

    sleep(Duration::from_secs(30));

    for mut node in hpl_val {
        node.1.kill().unwrap();
    }
    hpl_rly.1.kill().unwrap();
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_run() {
        run_locally()
    }
}
