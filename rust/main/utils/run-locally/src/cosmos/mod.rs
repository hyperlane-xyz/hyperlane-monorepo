#![allow(dead_code)] // TODO: `rustc` 1.80.1 clippy issue

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, Instant};
use std::{env, fs};

use cosmwasm_schema::cw_serde;
use hyperlane_cosmos::RawCosmosAmount;
use hyperlane_cosmwasm_interface::types::bech32_decode;
use macro_rules_attribute::apply;
use tempfile::tempdir;

mod cli;
mod crypto;
mod deploy;
mod link;
mod rpc;
mod source;
mod termination_invariants;
mod types;
mod utils;

use rpc::*;
use termination_invariants::*;
use types::*;
use utils::*;

use crate::cosmos::link::link_networks;
use crate::logging::log;
use crate::metrics::agent_balance_sum;
use crate::program::Program;
use crate::utils::{
    as_task, concat_path, get_workspace_path, stop_child, AgentHandles, TaskHandle,
};
use crate::AGENT_BIN_PATH;
use cli::{OsmosisCLI, OsmosisEndpoint};

use self::deploy::deploy_cw_hyperlane;
use self::source::{CLISource, CodeSource};

const OSMOSIS_CLI_GIT: &str = "https://github.com/osmosis-labs/osmosis";
const OSMOSIS_CLI_VERSION: &str = "20.5.0";

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

const CW_HYPERLANE_GIT: &str = "https://github.com/hyperlane-xyz/cosmwasm";
const CW_HYPERLANE_VERSION: &str = "v0.0.6";

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

#[cw_serde]
pub struct MockDispatch {
    pub dispatch: MockDispatchInner,
}

#[cw_serde]
pub struct MockDispatchInner {
    pub dest_domain: u32,
    pub recipient_addr: String,
    pub msg_body: String,
    pub hook: Option<String>,
    pub metadata: String,
}

pub fn install_codes(dir: Option<PathBuf>, local: bool) -> BTreeMap<String, PathBuf> {
    let dir_path = match dir {
        Some(path) => path,
        None => tempdir().unwrap().into_path(),
    };

    if !local {
        let dir_path_str = dir_path.to_str().unwrap();

        let release_comp = "wasm_codes.zip";

        log!(
            "Downloading {} @ {}",
            CW_HYPERLANE_GIT,
            CW_HYPERLANE_VERSION
        );
        let uri =
            format!("{CW_HYPERLANE_GIT}/releases/download/{CW_HYPERLANE_VERSION}/{release_comp}");
        download(release_comp, &uri, dir_path_str);

        log!("Uncompressing {} release", CW_HYPERLANE_GIT);
        unzip(release_comp, dir_path_str);
    }

    log!("Installing {} in Path: {:?}", CW_HYPERLANE_GIT, dir_path);

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
    cli_src: Option<CLISource>,
    codes_dir: Option<PathBuf>,
    _codes_src: Option<CodeSource>,
) -> (PathBuf, BTreeMap<String, PathBuf>) {
    let osmosisd = cli_src
        .unwrap_or(CLISource::Remote {
            url: OSMOSIS_CLI_GIT.to_string(),
            version: OSMOSIS_CLI_VERSION.to_string(),
        })
        .install(cli_dir);
    let codes = install_codes(codes_dir, false);

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
    pub metrics_port: u32,
    pub domain: u32,
}

impl Drop for CosmosNetwork {
    fn drop(&mut self) {
        stop_child(&mut self.launch_resp.node.1);
    }
}

impl From<(CosmosResp, Deployments, String, u32, u32)> for CosmosNetwork {
    fn from(v: (CosmosResp, Deployments, String, u32, u32)) -> Self {
        Self {
            launch_resp: v.0,
            deployments: v.1,
            chain_id: v.2,
            metrics_port: v.3,
            domain: v.4,
        }
    }
}
pub struct CosmosHyperlaneStack {
    pub validators: Vec<AgentHandles>,
    pub relayer: AgentHandles,
    pub scraper: AgentHandles,
    pub postgres: AgentHandles,
}

impl Drop for CosmosHyperlaneStack {
    fn drop(&mut self) {
        for v in &mut self.validators {
            stop_child(&mut v.1);
        }
        stop_child(&mut self.relayer.1);
        stop_child(&mut self.scraper.1);
        stop_child(&mut self.postgres.1);
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
    debug: bool,
) -> AgentHandles {
    let validator_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "validator");
    let validator_base = tempdir().expect("Failed to create a temp dir").into_path();
    let validator_base_db = concat_path(&validator_base, "db");

    fs::create_dir_all(&validator_base_db).unwrap();
    println!("Validator DB: {:?}", validator_base_db);

    let checkpoint_path = concat_path(&validator_base, "checkpoint");
    let signature_path = concat_path(&validator_base, "signature");

    let validator = Program::default()
        .bin(validator_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path.to_str().unwrap())
        .env(
            "MY_VALIDATOR_SIGNATURE_DIRECTORY",
            signature_path.to_str().unwrap(),
        )
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHECKPOINTSYNCER_PATH", checkpoint_path.to_str().unwrap())
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage")
        .hyp_env("ORIGINCHAINNAME", agent_config.name)
        .hyp_env("DB", validator_base_db.to_str().unwrap())
        .hyp_env("METRICSPORT", agent_config.metrics_port.to_string())
        .hyp_env("VALIDATOR_SIGNER_TYPE", agent_config.signer.typ)
        .hyp_env("VALIDATOR_KEY", agent_config.signer.key.clone())
        .hyp_env("VALIDATOR_PREFIX", "osmo")
        .hyp_env("SIGNER_SIGNER_TYPE", "hexKey")
        .hyp_env("SIGNER_KEY", agent_config.signer.key)
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .spawn("VAL", None);

    validator
}

#[apply(as_task)]
fn launch_cosmos_relayer(
    agent_config_path: String,
    relay_chains: Vec<String>,
    metrics: u32,
    debug: bool,
) -> AgentHandles {
    let relayer_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "relayer");
    let relayer_base = tempdir().unwrap();

    let relayer = Program::default()
        .bin(relayer_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("RELAYCHAINS", relay_chains.join(","))
        .hyp_env("DB", relayer_base.as_ref().to_str().unwrap())
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env("CHAINS_COSMOSTEST99990_MAXBATCHSIZE", "5")
        .hyp_env("CHAINS_COSMOSTEST99991_MAXBATCHSIZE", "5")
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .hyp_env("GASPAYMENTENFORCEMENT", "[{\"type\": \"none\"}]")
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("RLY", None);

    relayer
}

#[apply(as_task)]
#[allow(clippy::let_and_return)] // TODO: `rustc` 1.80.1 clippy issue
fn launch_cosmos_scraper(
    agent_config_path: String,
    chains: Vec<String>,
    metrics: u32,
    debug: bool,
) -> AgentHandles {
    let bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "scraper");

    let scraper = Program::default()
        .bin(bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHAINSTOSCRAPE", chains.join(","))
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("SCR", None);

    scraper
}

const ENV_CLI_PATH_KEY: &str = "E2E_OSMOSIS_CLI_PATH";
const ENV_CW_HYPERLANE_PATH_KEY: &str = "E2E_CW_HYPERLANE_PATH";

#[allow(dead_code)]
fn run_locally() {
    const TIMEOUT_SECS: u64 = 60 * 10;
    let debug = false;

    let workspace_path = get_workspace_path();

    log!("Building rust...");
    Program::new("cargo")
        .cmd("build")
        .working_dir(&workspace_path)
        .arg("features", "test-utils")
        .arg("bin", "relayer")
        .arg("bin", "validator")
        .arg("bin", "scraper")
        .arg("bin", "init-db")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run()
        .join();

    let cli_src = Some(
        env::var(ENV_CLI_PATH_KEY)
            .as_ref()
            .map(|v| CLISource::local(v))
            .unwrap_or_default(),
    );

    let code_src = Some(
        env::var(ENV_CW_HYPERLANE_PATH_KEY)
            .as_ref()
            .map(|v| CodeSource::local(v))
            .unwrap_or_default(),
    );

    let (osmosisd, codes) = install_cosmos(None, cli_src, None, code_src);
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
    let metrics_port_start = 9090u32;
    let domain_start = 99990u32;
    let node_count = 2;

    let nodes = (0..node_count)
        .map(|i| {
            (
                launch_cosmos_node(CosmosConfig {
                    node_port_base: port_start + (i * 10),
                    chain_id: format!("cosmos-test-{}", i + domain_start),
                    ..default_config.clone()
                }),
                format!("cosmos-test-{}", i + domain_start),
                metrics_port_start + i,
                domain_start + i,
            )
        })
        .collect::<Vec<_>>();

    let deployer = "validator";
    let linker = "validator";
    let validator = "hpl-validator";
    let _relayer = "hpl-relayer";

    let nodes = nodes
        .into_iter()
        .map(|v| (v.0.join(), v.1, v.2, v.3))
        .map(|(launch_resp, chain_id, metrics_port, domain)| {
            let deployments = deploy_cw_hyperlane(
                launch_resp.cli(&osmosisd),
                launch_resp.endpoint.clone(),
                deployer.to_string(),
                launch_resp.codes.clone(),
                domain,
            );

            (launch_resp, deployments, chain_id, metrics_port, domain)
        })
        .collect::<Vec<_>>();

    // nodes with base deployments
    let nodes = nodes
        .into_iter()
        .map(|v| (v.0, v.1.join(), v.2, v.3, v.4))
        .map(|v| v.into())
        .collect::<Vec<CosmosNetwork>>();

    for (i, node) in nodes.iter().enumerate() {
        let targets = &nodes[(i + 1)..];

        if !targets.is_empty() {
            println!(
                "LINKING NODES: {} -> {:?}",
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

    // count all the dispatched messages
    let mut dispatched_messages = 0;

    // dispatch the first batch of messages (before agents start)
    dispatched_messages += dispatch(&osmosisd, linker, &nodes);

    let config_dir = tempdir().unwrap();

    // export agent config
    let agent_config_out = AgentConfigOut {
        chains: nodes
            .iter()
            .map(|v| {
                (
                    format!("cosmostest{}", v.domain),
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

    log!("Running postgres db...");
    let postgres = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .arg("name", "scraper-testnet-postgres")
        .arg("env", "POSTGRES_PASSWORD=47221c18c610")
        .arg("publish", "5432:5432")
        .cmd("postgres:14")
        .spawn("SQL", None);

    sleep(Duration::from_secs(15));

    log!("Init postgres db...");
    Program::new(concat_path(format!("../../{AGENT_BIN_PATH}"), "init-db"))
        .run()
        .join();

    let hpl_val = agent_config_out
        .chains
        .clone()
        .into_values()
        .map(|agent_config| launch_cosmos_validator(agent_config, agent_config_path.clone(), debug))
        .collect::<Vec<_>>();

    let chains = agent_config_out.chains.into_keys().collect::<Vec<_>>();
    let path = agent_config_path.to_str().unwrap();

    let hpl_rly_metrics_port = metrics_port_start + node_count + 1u32;
    let hpl_rly =
        launch_cosmos_relayer(path.to_owned(), chains.clone(), hpl_rly_metrics_port, debug);

    let hpl_scr_metrics_port = hpl_rly_metrics_port + 1u32;
    let hpl_scr =
        launch_cosmos_scraper(path.to_owned(), chains.clone(), hpl_scr_metrics_port, debug);

    // give things a chance to fully start.
    sleep(Duration::from_secs(10));

    let starting_relayer_balance: f64 =
        agent_balance_sum(hpl_rly_metrics_port).expect("Failed to get relayer agent balance");

    // dispatch the second batch of messages (after agents start)
    dispatched_messages += dispatch(&osmosisd, linker, &nodes);

    let _stack = CosmosHyperlaneStack {
        validators: hpl_val.into_iter().map(|v| v.join()).collect(),
        relayer: hpl_rly.join(),
        scraper: hpl_scr.join(),
        postgres,
    };

    // Mostly copy-pasta from `rust/main/utils/run-locally/src/main.rs`
    // TODO: refactor to share code
    let loop_start = Instant::now();
    let mut failure_occurred = false;
    loop {
        // look for the end condition.
        if termination_invariants_met(
            hpl_rly_metrics_port,
            hpl_scr_metrics_port,
            dispatched_messages,
            starting_relayer_balance,
        )
        .unwrap_or(false)
        {
            // end condition reached successfully
            break;
        } else if (Instant::now() - loop_start).as_secs() > TIMEOUT_SECS {
            // we ran out of time
            log!("timeout reached before message submission was confirmed");
            failure_occurred = true;
            break;
        }

        sleep(Duration::from_secs(5));
    }

    if failure_occurred {
        panic!("E2E tests failed");
    } else {
        log!("E2E tests passed");
    }
}

fn dispatch(osmosisd: &Path, linker: &str, nodes: &[CosmosNetwork]) -> u32 {
    let mut dispatched_messages = 0;
    for node in nodes.iter() {
        let targets = nodes
            .iter()
            .filter(|v| v.domain != node.domain)
            .collect::<Vec<_>>();

        if !targets.is_empty() {
            println!(
                "DISPATCHING MAILBOX: {} -> {:?}",
                node.domain,
                targets.iter().map(|v| v.domain).collect::<Vec<_>>()
            );
        }

        for target in targets {
            dispatched_messages += 1;
            let cli = OsmosisCLI::new(
                osmosisd.to_path_buf(),
                node.launch_resp.home_path.to_str().unwrap(),
            );

            let msg_body: &[u8; 5] = b"hello";

            cli.wasm_execute(
                &node.launch_resp.endpoint,
                linker,
                &node.deployments.mailbox,
                MockDispatch {
                    dispatch: MockDispatchInner {
                        dest_domain: target.domain,
                        recipient_addr: hex::encode(
                            bech32_decode(&target.deployments.mock_receiver).unwrap(),
                        ),
                        msg_body: hex::encode(msg_body),
                        hook: None,
                        metadata: "".to_string(),
                    },
                },
                vec![RawCosmosAmount {
                    denom: "uosmo".to_string(),
                    amount: 25_000_000.to_string(),
                }],
            );
        }
    }

    dispatched_messages
}

#[cfg(feature = "cosmos")]
mod test {

    #[test]
    fn test_run() {
        use crate::cosmos::run_locally;

        run_locally()
    }
}
