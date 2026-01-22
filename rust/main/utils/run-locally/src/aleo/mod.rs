use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, Instant};
use std::{env, fs};

use hyperlane_core::SubmitterType;

use macro_rules_attribute::apply;
use tempfile::tempdir;

pub const CHAIN_ID: u32 = 1;
pub const KEY: (&str, &str) = (
    "b6b20a905295c296779d73ef2a43282ab8082c3f",
    "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
);
pub const HEX_KEY: &str = "0x5e5b34fbf0e6e22375fde0d2af0dcd789bd607a9423ece32bc281d7a28fa3612";

pub const CONSENSUS_HEIGHTS: &str = "0,1,2,3,4,5,6,7,8,9,10,11";
pub const NETWORK: &str = "testnet";
pub const SUBMITTER_TYPE: SubmitterType = SubmitterType::Classic;
const AGENT_BIN_PATH: &str = "target/release";

const HYPERLANE_ALEO_GIT: &str = "git@github.com:hyperlane-xyz/hyperlane-aleo.git";
const HYPERLANE_ALEO_VERSION: &str = "main";

use crate::aleo::aleo_termination_invariants::aleo_termination_invariants_met;
use crate::aleo::cli::AleoCli;
use crate::aleo::types::{AgentConfig, AgentConfigOut, Deployment};
use crate::utils::download;
use crate::AGENT_LOGGING_DIR;
use crate::{
    log,
    metrics::agent_balance_sum,
    program::Program,
    utils::{as_task, concat_path, stop_child, AgentHandles, TaskHandle},
    wait_for_condition, RELAYER_METRICS_PORT, SCRAPER_METRICS_PORT,
};

pub mod aleo_termination_invariants;
pub mod cli;
pub mod types;
pub mod utils;

pub struct AleoStack {
    pub validators: Vec<AgentHandles>,
    pub deployments: Vec<Deployment>,
    pub relayer: AgentHandles,
    pub scraper: AgentHandles,
    pub postgres: AgentHandles,
}

// this is for clean up
// kills all the remaining children
impl Drop for AleoStack {
    fn drop(&mut self) {
        stop_child(&mut self.relayer.1);
        stop_child(&mut self.scraper.1);
        stop_child(&mut self.postgres.1);

        self.validators
            .iter_mut()
            .for_each(|x| stop_child(&mut x.1));
        self.deployments
            .iter_mut()
            .for_each(|x| stop_child(&mut x.handle.1));

        fs::remove_dir_all::<&Path>(AGENT_LOGGING_DIR.as_ref()).unwrap_or_default();
    }
}

fn dispatch(deployments: &Vec<Deployment>) -> u32 {
    let mut transfers = 0;
    for local in deployments {
        for other in deployments {
            if other.domain == local.domain {
                continue;
            }
            local
                .cli
                .remote_transfer(&local.contracts.native, other.domain);
            transfers += 1;
        }
    }
    transfers
}

#[apply(as_task)]
fn launch_aleo_validator(agent_config: AgentConfig, agent_config_path: PathBuf) -> AgentHandles {
    let validator_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "validator");
    let validator_base = tempdir()
        .expect("Failed to create temporary directory for validator")
        .keep();
    let validator_base_db = concat_path(&validator_base, "db");

    fs::create_dir_all(&validator_base_db).expect("Failed to create validator database directory");
    println!("Validator DB: {:?}", validator_base_db);

    let checkpoint_path = concat_path(&validator_base, "checkpoint");
    let signature_path = concat_path(&validator_base, "signature");

    let validator = Program::default()
        .bin(validator_bin)
        .working_dir("../../")
        .env(
            "CONFIG_FILES",
            agent_config_path
                .to_str()
                .expect("Failed to convert agent config path to string"),
        )
        .env(
            "MY_VALIDATOR_SIGNATURE_DIRECTORY",
            signature_path
                .to_str()
                .expect("Failed to convert signature path to string"),
        )
        .env("RUST_BACKTRACE", "1")
        .hyp_env(
            "CHECKPOINTSYNCER_PATH",
            checkpoint_path
                .to_str()
                .expect("Failed to convert checkpoint path to string"),
        )
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage")
        .hyp_env("ORIGINCHAINNAME", agent_config.name)
        .hyp_env(
            "DB",
            validator_base_db
                .to_str()
                .expect("Failed to convert validator DB path to string"),
        )
        .hyp_env("METRICSPORT", agent_config.metrics_port.to_string())
        .hyp_env("VALIDATOR_KEY", HEX_KEY)
        .hyp_env("DEFAULTSIGNER_KEY", HEX_KEY)
        .spawn("VAL", None);

    validator
}

#[apply(as_task)]
fn launch_aleo_relayer(agent_config_path: String, relay_chains: Vec<String>) -> AgentHandles {
    let relayer_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "relayer");
    let relayer_base = tempdir().expect("Failed to create temporary directory for relayer");

    let relayer = Program::default()
        .bin(relayer_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("LOG_LEVEL", "debug")
        .hyp_env("RELAYCHAINS", relay_chains.join(","))
        .hyp_env(
            "DB",
            relayer_base
                .as_ref()
                .to_str()
                .expect("Failed to convert relayer base path to string"),
        )
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env("DEFAULTSIGNER_KEY", HEX_KEY)
        .hyp_env("CHAINS_aleoTEST0_SUBMITTER", SUBMITTER_TYPE.to_string())
        .hyp_env("CHAINS_aleoTEST1_SUBMITTER", SUBMITTER_TYPE.to_string())
        .hyp_env(
            "GASPAYMENTENFORCEMENT",
            r#"[{
                "type": "minimum",
                "payment": "1"
            }]"#,
        )
        .hyp_env("METRICSPORT", RELAYER_METRICS_PORT)
        .spawn("RLY", Some(&AGENT_LOGGING_DIR));

    relayer
}

#[apply(as_task)]
fn launch_aleo_scraper(agent_config_path: String, chains: Vec<String>) -> AgentHandles {
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
        .hyp_env("METRICSPORT", SCRAPER_METRICS_PORT)
        .spawn("SCR", None);

    scraper
}

fn download_hyperlane_aleo() -> String {
    let dir_path = tempdir()
        .expect("Failed to create temporary directory")
        .keep();
    let dir_path = dir_path
        .to_str()
        .expect("Failed to convert temp directory path to string");

    log!("Cloning hyperlane-aleo `{}`", HYPERLANE_ALEO_VERSION);

    Program::new("git")
        .cmd("clone")
        .arg("branch", HYPERLANE_ALEO_VERSION)
        .cmd(HYPERLANE_ALEO_GIT)
        .cmd(dir_path)
        .run()
        .join();

    Program::new("cp")
        .working_dir(dir_path)
        .cmd(".env.template")
        .cmd(".env")
        .run()
        .join();

    dir_path.to_string()
}

const ENV_LEO_CLI: &str = "E2E_LEO_CLI_PATH";

#[allow(dead_code)]
pub fn run_locally() {
    Program::new("cargo")
        .cmd("build")
        .working_dir("../../")
        .flag("release")
        .arg("features", "test-utils,aleo")
        .arg("bin", "relayer")
        .arg("bin", "validator")
        .arg("bin", "scraper")
        .arg("bin", "init-db")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run()
        .join();

    let leo = env::var(ENV_LEO_CLI);
    let leo = leo
        .as_ref()
        .expect("No leo CLI found, set E2E_LEO_CLI_PATH env var");
    let hyperlane_aleo = download_hyperlane_aleo();

    let metrics_port_start = 9090u32;
    // Localdomains: aleotest0, aleotest1
    let domains = vec![9913376u32, 9913377u32];
    let deployments = domains
        .clone()
        .into_iter()
        .enumerate()
        .map(|(i, local_domain)| {
            let cli = AleoCli::new(leo.clone(), hyperlane_aleo.clone(), 3030u32 + i as u32);
            let other_domains = domains
                .clone()
                .into_iter()
                .filter(|other| *other != local_domain)
                .collect::<Vec<_>>();
            let (contracts, handle) = cli.initialize(local_domain, other_domains);
            Deployment {
                cli,
                name: format!("aleotest{}", i),
                metrics: metrics_port_start + i as u32,
                domain: local_domain,
                contracts,
                handle,
            }
        })
        .collect::<Vec<_>>();

    // Mostly copy-pasta from `rust/main/utils/run-locally/src/main.rs`

    // count all the dispatched messages
    let mut dispatched_messages = 0;
    // dispatch the first batch of messages (before agents start)
    dispatched_messages += dispatch(&deployments);
    let config_dir = tempdir().expect("Failed to create temporary directory for agent config");
    // export agent config
    let agent_config_out = AgentConfigOut {
        chains: deployments
            .iter()
            .map(|v| (v.name.clone(), AgentConfig::new(v)))
            .collect::<BTreeMap<String, AgentConfig>>(),
    };

    let agent_config_path = concat_path(&config_dir, "config.json");
    fs::write(
        &agent_config_path,
        serde_json::to_string_pretty(&agent_config_out)
            .expect("Failed to serialize agent config to JSON"),
    )
    .expect("Failed to write agent config file");

    log!("Config path: {:#?}", agent_config_path);
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
        .map(|agent_config| launch_aleo_validator(agent_config, agent_config_path.clone()))
        .collect::<Vec<_>>();

    let chains = agent_config_out.chains.into_keys().collect::<Vec<_>>();
    let path = agent_config_path
        .to_str()
        .expect("Failed to convert agent config path to string");

    let hpl_rly = launch_aleo_relayer(path.to_owned(), chains.clone());
    let hpl_scr = launch_aleo_scraper(path.to_owned(), chains.clone());

    // give things a chance to fully start.
    sleep(Duration::from_secs(20));

    let relayer_metrics_port: u32 = RELAYER_METRICS_PORT
        .parse()
        .expect("Failed to parse relayer metrics port");
    let scraper_metrics_port: u32 = SCRAPER_METRICS_PORT
        .parse()
        .expect("Failed to parse scraper metrics port");

    let starting_relayer_balance: f64 =
        agent_balance_sum(relayer_metrics_port).expect("Failed to get starting relayer balance");

    // dispatch the second batch of messages (after agents start)
    dispatched_messages += dispatch(&deployments);

    let _stack = AleoStack {
        validators: hpl_val.into_iter().map(|v| v.join()).collect(),
        relayer: hpl_rly.join(),
        scraper: hpl_scr.join(),
        postgres,
        deployments,
    };

    // Use the standard wait_for_condition function with config
    let config = crate::config::Config::load(); // Load the config for invariants
    let loop_start = Instant::now();
    let test_passed = wait_for_condition(
        &config,
        loop_start,
        || {
            aleo_termination_invariants_met(
                &config,
                starting_relayer_balance,
                scraper_metrics_port,
                dispatched_messages,
            )
        },
        || true,  // Always continue (no external shutdown signal for aleo tests)
        || false, // No long-running process checks for aleo
    );

    if !test_passed {
        panic!("Aleo E2E tests failed");
    } else {
        log!("Aleo E2E tests passed");
    }
}

#[cfg(feature = "aleo")]
#[cfg(test)]
mod test {
    #[test]
    fn test_run() {
        use crate::aleo::run_locally;

        run_locally()
    }
}
