//! Run this from the hyperlane-monorepo/rust directory using `cargo run -r -p
//! run-locally`.
//!
//! Environment arguments:
//! - `E2E_CI_MODE`: true/false, enables CI mode which will automatically wait
//!   for kathy to finish
//! running and for the queues to empty. Defaults to false.
//! - `E2E_CI_TIMEOUT_SEC`: How long (in seconds) to allow the main loop to run
//!   the test for. This
//! does not include the initial setup time. If this timeout is reached before
//! the end conditions are met, the test is a failure. Defaults to 10 min.
//! - `E2E_KATHY_MESSAGES`: Number of kathy messages to dispatch. Defaults to 16 if CI mode is enabled.
//! else false.

use std::path::Path;
use std::{
    fs,
    process::{Child, ExitCode},
    sync::atomic::{AtomicBool, Ordering},
    thread::sleep,
    time::{Duration, Instant},
};

use tempfile::tempdir;

use logging::log;
pub use metrics::fetch_metric;
use program::Program;

use crate::config::Config;
use crate::ethereum::start_anvil;
use crate::invariants::termination_invariants_met;
use crate::solana::*;
use crate::utils::{concat_path, make_static, stop_child, AgentHandles, ArbitraryData, TaskHandle};

mod config;
mod ethereum;
mod invariants;
mod logging;
mod metrics;
mod program;
mod solana;
mod utils;

/// These private keys are from hardhat/anvil's testing accounts.
const RELAYER_KEYS: &[&str] = &[
    // test1
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
    // test2
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    // test3
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    // sealeveltest1
    "0x892bf6949af4233e62f854cb3618bc1a3ee3341dc71ada08c4d5deca239acf4f",
    // sealeveltest2
    "0x892bf6949af4233e62f854cb3618bc1a3ee3341dc71ada08c4d5deca239acf4f",
];
/// These private keys are from hardhat/anvil's testing accounts.
/// These must be consistent with the ISM config for the test.
const VALIDATOR_KEYS: &[&str] = &[
    // eth
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    // sealevel
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
];

const VALIDATOR_ORIGIN_CHAINS: &[&str] = &["test1", "test2", "test3", "sealeveltest1"];

const AGENT_BIN_PATH: &str = "target/debug";
const INFRA_PATH: &str = "../typescript/infra";
const TS_SDK_PATH: &str = "../typescript/sdk";
const MONOREPO_ROOT_PATH: &str = "../";

type DynPath = Box<dyn AsRef<Path>>;

static RUN_LOG_WATCHERS: AtomicBool = AtomicBool::new(true);
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// Struct to hold stuff we want to cleanup whenever we exit. Just using for
/// cleanup purposes at this time.
#[derive(Default)]
struct State {
    agents: Vec<(String, Child)>,
    watchers: Vec<Box<dyn TaskHandle<Output = ()>>>,
    data: Vec<Box<dyn ArbitraryData>>,
}
impl State {
    fn push_agent(&mut self, handles: AgentHandles) {
        self.agents.push((handles.0, handles.1));
        self.watchers.push(handles.2);
        self.watchers.push(handles.3);
        self.data.push(handles.4);
    }
}
impl Drop for State {
    fn drop(&mut self) {
        SHUTDOWN.store(true, Ordering::Relaxed);
        log!("Signaling children to stop...");
        // stop children in reverse order
        self.agents.reverse();
        for (name, mut agent) in self.agents.drain(..) {
            log!("Stopping child {}", name);
            stop_child(&mut agent);
        }
        log!("Joining watchers...");
        RUN_LOG_WATCHERS.store(false, Ordering::Relaxed);
        for w in self.watchers.drain(..) {
            w.join_box();
        }
        // drop any held data
        self.data.reverse();
        for data in self.data.drain(..) {
            drop(data)
        }
        fs::remove_dir_all(SOLANA_CHECKPOINT_LOCATION).unwrap_or_default();
    }
}

fn main() -> ExitCode {
    // on sigint we want to trigger things to stop running
    ctrlc::set_handler(|| {
        log!("Terminating...");
        SHUTDOWN.store(true, Ordering::Relaxed);
    })
    .unwrap();

    assert_eq!(VALIDATOR_ORIGIN_CHAINS.len(), VALIDATOR_KEYS.len());
    const VALIDATOR_COUNT: usize = VALIDATOR_KEYS.len();

    let config = Config::load();

    let solana_checkpoint_path = Path::new(SOLANA_CHECKPOINT_LOCATION);
    fs::remove_dir_all(solana_checkpoint_path).unwrap_or_default();
    let checkpoints_dirs: Vec<DynPath> = (0..VALIDATOR_COUNT - 1)
        .map(|_| Box::new(tempdir().unwrap()) as DynPath)
        .chain([Box::new(solana_checkpoint_path) as DynPath])
        .collect();
    let rocks_db_dir = tempdir().unwrap();
    let relayer_db = concat_path(&rocks_db_dir, "relayer");
    let validator_dbs = (0..VALIDATOR_COUNT)
        .map(|i| concat_path(&rocks_db_dir, format!("validator{i}")))
        .collect::<Vec<_>>();

    let common_agent_env = Program::default()
        .env("RUST_BACKTRACE", "full")
        .hyp_env("TRACING_FMT", "compact")
        .hyp_env("TRACING_LEVEL", "debug")
        .hyp_env("CHAINS_TEST1_INDEX_CHUNK", "1")
        .hyp_env("CHAINS_TEST2_INDEX_CHUNK", "1")
        .hyp_env("CHAINS_TEST3_INDEX_CHUNK", "1");

    let relayer_env = common_agent_env
        .clone()
        .bin(concat_path(AGENT_BIN_PATH, "relayer"))
        .hyp_env("CHAINS_TEST1_CONNECTION_TYPE", "httpFallback")
        .hyp_env(
            "CHAINS_TEST2_CONNECTION_URLS",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        // by setting this as a quorum provider we will cause nonce errors when delivering to test2
        // because the message will be sent to the node 3 times.
        .hyp_env("CHAINS_TEST2_CONNECTION_TYPE", "httpQuorum")
        .hyp_env("CHAINS_TEST3_CONNECTION_URL", "http://127.0.0.1:8545")
        .hyp_env("METRICS", "9092")
        .hyp_env("DB", relayer_db.to_str().unwrap())
        .hyp_env("CHAINS_TEST1_SIGNER_KEY", RELAYER_KEYS[0])
        .hyp_env("CHAINS_TEST2_SIGNER_KEY", RELAYER_KEYS[1])
        .hyp_env("CHAINS_SEALEVELTEST1_SIGNER_KEY", RELAYER_KEYS[3])
        .hyp_env("CHAINS_SEALEVELTEST2_SIGNER_KEY", RELAYER_KEYS[4])
        .hyp_env("RELAYCHAINS", "invalidchain,otherinvalid")
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .arg(
            "chains.test1.connection.urls",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        // default is used for TEST3
        .arg("defaultSigner.key", RELAYER_KEYS[2])
        .arg(
            "relayChains",
            "test1,test2,test3,sealeveltest1,sealeveltest2",
        );

    let base_validator_env = common_agent_env
        .clone()
        .bin(concat_path(AGENT_BIN_PATH, "validator"))
        .hyp_env(
            "CHAINS_TEST1_CONNECTION_URLS",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        .hyp_env("CHAINS_TEST1_CONNECTION_TYPE", "httpQuorum")
        .hyp_env(
            "CHAINS_TEST2_CONNECTION_URLS",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        .hyp_env("CHAINS_TEST2_CONNECTION_TYPE", "httpFallback")
        .hyp_env("CHAINS_TEST3_CONNECTION_URL", "http://127.0.0.1:8545")
        .hyp_env("REORGPERIOD", "0")
        .hyp_env("INTERVAL", "5")
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage");

    let validator_envs = (0..VALIDATOR_COUNT)
        .map(|i| {
            base_validator_env
                .clone()
                .hyp_env("METRICS", (9094 + i).to_string())
                .hyp_env("DB", validator_dbs[i].to_str().unwrap())
                .hyp_env("ORIGINCHAINNAME", VALIDATOR_ORIGIN_CHAINS[i])
                .hyp_env("VALIDATOR_KEY", VALIDATOR_KEYS[i])
                .hyp_env(
                    "CHECKPOINTSYNCER_PATH",
                    (*checkpoints_dirs[i]).as_ref().to_str().unwrap(),
                )
        })
        .collect::<Vec<_>>();

    let scraper_env = common_agent_env
        .bin(concat_path(AGENT_BIN_PATH, "scraper"))
        .hyp_env("CHAINS_TEST1_CONNECTION_TYPE", "httpQuorum")
        .hyp_env("CHAINS_TEST1_CONNECTION_URL", "http://127.0.0.1:8545")
        .hyp_env("CHAINS_TEST2_CONNECTION_TYPE", "httpQuorum")
        .hyp_env("CHAINS_TEST2_CONNECTION_URL", "http://127.0.0.1:8545")
        .hyp_env("CHAINS_TEST3_CONNECTION_TYPE", "httpQuorum")
        .hyp_env("CHAINS_TEST3_CONNECTION_URL", "http://127.0.0.1:8545")
        .hyp_env("CHAINSTOSCRAPE", "test1,test2,test3")
        .hyp_env("METRICS", "9093")
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        );

    let mut state = State::default();

    log!(
        "Signed checkpoints in {}",
        checkpoints_dirs
            .iter()
            .map(|d| (**d).as_ref().display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    log!("Relayer DB in {}", relayer_db.display());
    (0..3).for_each(|i| {
        log!("Validator {} DB in {}", i + 1, validator_dbs[i].display());
    });

    //
    // Ready to run...
    //

    let (solana_path, solana_path_tempdir) = install_solana_cli_tools().join();
    state.data.push(Box::new(solana_path_tempdir));
    let solana_program_builder = build_solana_programs(solana_path.clone());

    // this task takes a long time in the CI so run it in parallel
    log!("Building rust...");
    let build_rust = Program::new("cargo")
        .cmd("build")
        .arg("features", "test-utils")
        .arg("bin", "relayer")
        .arg("bin", "validator")
        .arg("bin", "scraper")
        .arg("bin", "init-db")
        .arg("bin", "hyperlane-sealevel-client")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run();

    let start_anvil = start_anvil(config.clone());

    let solana_program_path = solana_program_builder.join();

    log!("Running postgres db...");
    let postgres = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .arg("name", "scraper-testnet-postgres")
        .arg("env", "POSTGRES_PASSWORD=47221c18c610")
        .arg("publish", "5432:5432")
        .cmd("postgres:14")
        .spawn("SQL");
    state.push_agent(postgres);

    build_rust.join();

    let solana_ledger_dir = tempdir().unwrap();
    let start_solana_validator = start_solana_test_validator(
        solana_path.clone(),
        solana_program_path,
        solana_ledger_dir.as_ref().to_path_buf(),
    );

    let (solana_config_path, solana_validator) = start_solana_validator.join();
    state.push_agent(solana_validator);
    state.push_agent(start_anvil.join());

    // spawn 1st validator before any messages have been sent to test empty mailbox
    state.push_agent(validator_envs.first().unwrap().clone().spawn("VL1"));

    sleep(Duration::from_secs(5));

    log!("Init postgres db...");
    Program::new(concat_path(AGENT_BIN_PATH, "init-db"))
        .run()
        .join();
    state.push_agent(scraper_env.spawn("SCR"));

    // Send half the kathy messages before starting the rest of the agents
    let kathy_env = Program::new("yarn")
        .working_dir(INFRA_PATH)
        .cmd("kathy")
        .arg("messages", (config.kathy_messages / 2).to_string())
        .arg("timeout", "1000");
    kathy_env.clone().run().join();

    // spawn the rest of the validators
    for (i, validator_env) in validator_envs.into_iter().enumerate().skip(1) {
        let validator = validator_env.spawn(make_static(format!("VL{}", 1 + i)));
        state.push_agent(validator);
    }

    state.push_agent(relayer_env.spawn("RLY"));

    initiate_solana_hyperlane_transfer(solana_path.clone(), solana_config_path.clone()).join();

    log!("Setup complete! Agents running in background...");
    log!("Ctrl+C to end execution...");

    // Send half the kathy messages after the relayer comes up
    state.push_agent(kathy_env.flag("mineforever").spawn("KTY"));

    let loop_start = Instant::now();
    // give things a chance to fully start.
    sleep(Duration::from_secs(5));
    let mut failure_occurred = false;
    while !SHUTDOWN.load(Ordering::Relaxed) {
        if config.ci_mode {
            // for CI we have to look for the end condition.
            if termination_invariants_met(&config, &solana_path, &solana_config_path)
                .unwrap_or(false)
            {
                // end condition reached successfully
                break;
            } else if (Instant::now() - loop_start).as_secs() > config.ci_mode_timeout {
                // we ran out of time
                log!("CI timeout reached before queues emptied");
                failure_occurred = true;
                break;
            }
        }

        // verify long-running tasks are still running
        for (name, child) in state.agents.iter_mut() {
            if child.try_wait().unwrap().is_some() {
                log!("Child process {} exited unexpectedly, shutting down", name);
                failure_occurred = true;
                SHUTDOWN.store(true, Ordering::Relaxed);
                break;
            }
        }

        sleep(Duration::from_secs(5));
    }

    if failure_occurred {
        log!("E2E tests failed");
        ExitCode::FAILURE
    } else {
        log!("E2E tests passed");
        ExitCode::SUCCESS
    }
}
