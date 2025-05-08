#![allow(clippy::doc_lazy_continuation)] // TODO: `rustc` 1.80.1 clippy issue

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

use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::Path,
    process::{Child, ExitCode},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::sleep,
    time::{Duration, Instant},
};

use ethers_contract::MULTICALL_ADDRESS;
use hyperlane_core::{PendingOperationStatus, ReorgEvent, ReprepareReason};
use logging::log;
pub use metrics::fetch_metric;
use once_cell::sync::Lazy;
use program::Program;
use relayer::msg::pending_message::{INVALIDATE_CACHE_METADATA_LOG, RETRIEVED_MESSAGE_LOG};
use tempfile::{tempdir, TempDir};
use utils::{get_matching_lines, get_ts_infra_path};

use crate::{
    config::Config,
    ethereum::{start_anvil, termination_invariants::termination_invariants_met},
    invariants::post_startup_invariants,
    metrics::agent_balance_sum,
    utils::{concat_path, make_static, stop_child, AgentHandles, ArbitraryData, TaskHandle},
};

mod config;
mod ethereum;
mod invariants;
mod logging;
mod metrics;
mod program;
mod server;
mod utils;

#[cfg(feature = "cosmos")]
mod cosmos;

#[cfg(feature = "sealevel")]
mod sealevel;

#[cfg(feature = "cosmosnative")]
mod cosmosnative;

#[cfg(feature = "starknet")]
mod starknet;

pub static AGENT_LOGGING_DIR: Lazy<&Path> = Lazy::new(|| {
    let dir = Path::new("/tmp/test_logs");
    fs::create_dir_all(dir).unwrap();
    dir
});

/// These private keys are from hardhat/anvil's testing accounts.
const RELAYER_KEYS: &[&str] = &[
    // test1
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
    // test2
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    // test3
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
];
/// These private keys are from hardhat/anvil's testing accounts.
/// These must be consistent with the ISM config for the test.
const ETH_VALIDATOR_KEYS: &[&str] = &[
    // eth
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
];

const AGENT_BIN_PATH: &str = "target/debug";

const ZERO_MERKLE_INSERTION_KATHY_MESSAGES: u32 = 10;
const FAILED_MESSAGE_COUNT: u32 = 1;

const RELAYER_METRICS_PORT: &str = "9092";
const SCRAPER_METRICS_PORT: &str = "9093";

type DynPath = Box<dyn AsRef<Path>>;

static RUN_LOG_WATCHERS: AtomicBool = AtomicBool::new(true);
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// Struct to hold stuff we want to cleanup whenever we exit. Just using for
/// cleanup purposes at this time.
#[derive(Default)]
struct State {
    #[allow(clippy::type_complexity)]
    agents: HashMap<String, (Child, Option<Arc<Mutex<File>>>)>,
    watchers: Vec<Box<dyn TaskHandle<Output = ()>>>,
    data: Vec<Box<dyn ArbitraryData>>,
}

impl State {
    fn push_agent(&mut self, handles: AgentHandles) {
        log!("Pushing {} agent handles", handles.0);
        self.agents.insert(handles.0, (handles.1, handles.5));
        self.watchers.push(handles.2);
        self.watchers.push(handles.3);
        self.data.push(handles.4);
    }
}

impl Drop for State {
    fn drop(&mut self) {
        SHUTDOWN.store(true, Ordering::Relaxed);
        log!("Signaling children to stop...");
        for (name, (mut agent, _)) in self.agents.drain() {
            log!("Stopping child {}", name);
            stop_child(&mut agent);
        }
        RUN_LOG_WATCHERS.store(false, Ordering::Relaxed);

        log!("Joining watchers...");
        let watchers_count = self.watchers.len();
        for (i, w) in self.watchers.drain(..).enumerate() {
            log!("Joining {}/{}", i + 1, watchers_count);
            w.join_box();
        }

        log!("Dropping data...");
        // drop any held data
        self.data.reverse();
        for data in self.data.drain(..) {
            drop(data)
        }
        #[cfg(feature = "sealevel")]
        {
            use sealevel::solana::SOLANA_CHECKPOINT_LOCATION;
            fs::remove_dir_all(SOLANA_CHECKPOINT_LOCATION).unwrap_or_default();
        }
        fs::remove_dir_all::<&Path>(AGENT_LOGGING_DIR.as_ref()).unwrap_or_default();

        log!("Done...");
    }
}

fn main() -> ExitCode {
    // on sigint we want to trigger things to stop running
    ctrlc::set_handler(|| {
        log!("Terminating...");
        SHUTDOWN.store(true, Ordering::Relaxed);
    })
    .unwrap();

    let config = Config::load();
    log!("Running with config: {:?}", config);

    let ts_infra_path = get_ts_infra_path();

    let validator_origin_chains = ["test1", "test2", "test3"].to_vec();
    let validator_keys = ETH_VALIDATOR_KEYS.to_vec();
    let validator_count: usize = validator_keys.len();
    let checkpoints_dirs: Vec<DynPath> = (0..validator_count)
        .map(|_| Box::new(tempdir().unwrap()) as DynPath)
        .collect();
    assert_eq!(validator_origin_chains.len(), validator_keys.len());

    let rocks_db_dir = tempdir().unwrap();
    let relayer_db = concat_path(&rocks_db_dir, "relayer");
    let validator_dbs = (0..validator_count)
        .map(|i| concat_path(&rocks_db_dir, format!("validator{i}")))
        .collect::<Vec<_>>();

    let common_agent_env = create_common_agent();
    let relayer_env = create_relayer(&rocks_db_dir);

    let base_validator_env = common_agent_env
        .clone()
        .bin(concat_path(AGENT_BIN_PATH, "validator"))
        .hyp_env(
            "CHAINS_TEST1_CUSTOMRPCURLS",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        .hyp_env("CHAINS_TEST1_RPCCONSENSUSTYPE", "quorum")
        .hyp_env(
            "CHAINS_TEST2_CUSTOMRPCURLS",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        .hyp_env("CHAINS_TEST2_RPCCONSENSUSTYPE", "fallback")
        .hyp_env("CHAINS_TEST3_CUSTOMRPCURLS", "http://127.0.0.1:8545")
        .hyp_env("CHAINS_TEST1_BLOCKS_REORGPERIOD", "0")
        .hyp_env("CHAINS_TEST2_BLOCKS_REORGPERIOD", "0")
        .hyp_env("CHAINS_TEST3_BLOCKS_REORGPERIOD", "0")
        .hyp_env("INTERVAL", "5")
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage");

    let validator_envs = (0..validator_count)
        .map(|i| {
            base_validator_env
                .clone()
                .hyp_env("METRICSPORT", (9094 + i).to_string())
                .hyp_env("DB", validator_dbs[i].to_str().unwrap())
                .hyp_env("ORIGINCHAINNAME", validator_origin_chains[i])
                .hyp_env("VALIDATOR_KEY", validator_keys[i])
                .hyp_env(
                    "CHECKPOINTSYNCER_PATH",
                    (*checkpoints_dirs[i]).as_ref().to_str().unwrap(),
                )
        })
        .collect::<Vec<_>>();

    let scraper_env = common_agent_env
        .bin(concat_path(AGENT_BIN_PATH, "scraper"))
        .hyp_env("CHAINS_TEST1_RPCCONSENSUSTYPE", "quorum")
        .hyp_env("CHAINS_TEST1_CUSTOMRPCURLS", "http://127.0.0.1:8545")
        .hyp_env("CHAINS_TEST2_RPCCONSENSUSTYPE", "quorum")
        .hyp_env("CHAINS_TEST2_CUSTOMRPCURLS", "http://127.0.0.1:8545")
        .hyp_env("CHAINS_TEST3_RPCCONSENSUSTYPE", "quorum")
        .hyp_env("CHAINS_TEST3_CUSTOMRPCURLS", "http://127.0.0.1:8545")
        .hyp_env("METRICSPORT", SCRAPER_METRICS_PORT)
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("CHAINSTOSCRAPE", "test1,test2,test3");

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
    (0..validator_count).for_each(|i| {
        log!("Validator {} DB in {}", i + 1, validator_dbs[i].display());
    });

    //
    // Ready to run...
    //

    // this task takes a long time in the CI so run it in parallel
    log!("Building rust...");
    let build_main = Program::new("cargo")
        .cmd("build")
        .arg("features", "test-utils memory-profiling")
        .arg("bin", "relayer")
        .arg("bin", "validator")
        .arg("bin", "scraper")
        .arg("bin", "init-db")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run();

    let start_anvil = start_anvil(config.clone());

    log!("Running postgres db...");
    let postgres = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .arg("name", "scraper-testnet-postgres")
        .arg("env", "POSTGRES_PASSWORD=47221c18c610")
        .arg("publish", "5432:5432")
        .cmd("postgres:14")
        .spawn("SQL", None);
    state.push_agent(postgres);

    build_main.join();

    state.push_agent(start_anvil.join());

    // spawn 1st validator before any messages have been sent to test empty mailbox
    state.push_agent(validator_envs.first().unwrap().clone().spawn("VL1", None));

    sleep(Duration::from_secs(5));

    log!("Init postgres db...");
    Program::new(concat_path(AGENT_BIN_PATH, "init-db"))
        .run()
        .join();
    state.push_agent(scraper_env.spawn("SCR", None));

    // Send a message that's guaranteed to fail
    // "failMessageBody" hex value is 0x6661696c4d657373616765426f6479
    let fail_message_body = format!("0x{}", hex::encode("failMessageBody"));
    let kathy_failed_tx = Program::new("yarn")
        .working_dir(&ts_infra_path)
        .cmd("kathy")
        .arg("messages", FAILED_MESSAGE_COUNT.to_string())
        .arg("timeout", "1000")
        .arg("body", fail_message_body.as_str());
    kathy_failed_tx.clone().run().join();

    // Send half the kathy messages before starting the rest of the agents
    let kathy_env_single_insertion = Program::new("yarn")
        .working_dir(&ts_infra_path)
        .cmd("kathy")
        .arg("messages", (config.kathy_messages / 4).to_string())
        .arg("timeout", "1000");
    kathy_env_single_insertion.clone().run().join();

    let kathy_env_zero_insertion = Program::new("yarn")
        .working_dir(&ts_infra_path)
        .cmd("kathy")
        .arg(
            "messages",
            (ZERO_MERKLE_INSERTION_KATHY_MESSAGES / 2).to_string(),
        )
        .arg("timeout", "1000")
        // replacing the `aggregationHook` with the `interchainGasPaymaster` means there
        // is no more `merkleTreeHook`, causing zero merkle insertions to occur.
        .arg("default-hook", "interchainGasPaymaster");
    kathy_env_zero_insertion.clone().run().join();

    let kathy_env_double_insertion = Program::new("yarn")
        .working_dir(&ts_infra_path)
        .cmd("kathy")
        .arg("messages", (config.kathy_messages / 4).to_string())
        .arg("timeout", "1000")
        // replacing the `protocolFees` required hook with the `merkleTreeHook`
        // will cause double insertions to occur, which should be handled correctly
        .arg("required-hook", "merkleTreeHook");
    kathy_env_double_insertion.clone().run().join();

    // spawn the rest of the validators
    for (i, validator_env) in validator_envs.into_iter().enumerate().skip(1) {
        let validator = validator_env.spawn(
            make_static(format!("VL{}", 1 + i)),
            Some(AGENT_LOGGING_DIR.as_ref()),
        );
        state.push_agent(validator);
    }

    state.push_agent(relayer_env.spawn("RLY", Some(&AGENT_LOGGING_DIR)));

    log!("Setup complete! Agents running in background...");
    log!("Ctrl+C to end execution...");

    // Send half the kathy messages after the relayer comes up
    kathy_env_double_insertion.clone().run().join();
    kathy_env_zero_insertion.clone().run().join();
    state.push_agent(
        kathy_env_single_insertion
            .flag("mineforever")
            .spawn("KTY", None),
    );

    let loop_start = Instant::now();
    // give things a chance to fully start.
    sleep(Duration::from_secs(10));

    if !post_startup_invariants(&checkpoints_dirs) {
        log!("Failure: Post startup invariants are not met");
        return report_test_result(false);
    } else {
        log!("Success: Post startup invariants are met");
    }

    let starting_relayer_balance: f64 = agent_balance_sum(9092).unwrap();

    // wait for CI invariants to pass
    let mut test_passed = wait_for_condition(
        &config,
        loop_start,
        || termination_invariants_met(&config, starting_relayer_balance),
        || !SHUTDOWN.load(Ordering::Relaxed),
        || long_running_processes_exited_check(&mut state),
    );

    if !test_passed {
        log!("Failure occurred during E2E");
        return report_test_result(test_passed);
    }

    // Simulate a reorg, which we'll later use
    // to ensure the relayer handles reorgs correctly.
    // Kill validator 1 to make sure it doesn't crash by detecting it posted a reorg,
    // causing e2e to also fail.
    stop_validator(&mut state, 1);
    set_validator_reorg_flag(&checkpoints_dirs, 1);

    // Send a single message from validator 1's origin chain to test the relayer's reorg handling.
    Program::new("yarn")
        .working_dir(ts_infra_path)
        .cmd("kathy")
        .arg("messages", "1")
        .arg("timeout", "1000")
        .arg("single-origin", "test1")
        .run()
        .join();

    // Here we want to restart the relayer and validate
    // its restart behaviour.
    restart_relayer(&mut state, &rocks_db_dir);

    // give relayer a chance to fully restart.
    sleep(Duration::from_secs(20));

    let loop_start = Instant::now();
    // wait for Relayer restart invariants to pass
    test_passed = wait_for_condition(
        &config,
        loop_start,
        || {
            Ok(
                relayer_restart_invariants_met()? && relayer_reorg_handling_invariants_met()?,
                // TODO: fix and uncomment
                // && relayer_cached_metadata_invariant_met()?
            )
        },
        || !SHUTDOWN.load(Ordering::Relaxed),
        || long_running_processes_exited_check(&mut state),
    );

    // test retry request
    let resp = server::run_retry_request().expect("Failed to process retry request");
    assert!(resp.matched > 0);

    report_test_result(test_passed)
}

fn create_common_agent() -> Program {
    Program::default()
        .env("RUST_BACKTRACE", "full")
        .hyp_env("LOG_FORMAT", "compact")
        .hyp_env("LOG_LEVEL", "debug")
        .hyp_env("CHAINS_TEST1_INDEX_CHUNK", "1")
        .hyp_env("CHAINS_TEST2_INDEX_CHUNK", "1")
        .hyp_env("CHAINS_TEST3_INDEX_CHUNK", "1")
}

fn create_relayer(rocks_db_dir: &TempDir) -> Program {
    let relayer_db = concat_path(rocks_db_dir, "relayer");

    let common_agent_env = create_common_agent();

    let multicall_address_string: String = format!("0x{}", hex::encode(MULTICALL_ADDRESS));

    common_agent_env
        .clone()
        .bin(concat_path(AGENT_BIN_PATH, "relayer"))
        .hyp_env("CHAINS_TEST1_RPCCONSENSUSTYPE", "fallback")
        .hyp_env(
            "CHAINS_TEST2_CONNECTION_URLS",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        .hyp_env(
            "CHAINS_TEST1_BATCHCONTRACTADDRESS",
            multicall_address_string.clone(),
        )
        .hyp_env("CHAINS_TEST1_MAXBATCHSIZE", "5")
        // by setting this as a quorum provider we will cause nonce errors when delivering to test2
        // because the message will be sent to the node 3 times.
        .hyp_env("CHAINS_TEST2_RPCCONSENSUSTYPE", "quorum")
        .hyp_env(
            "CHAINS_TEST2_BATCHCONTRACTADDRESS",
            multicall_address_string.clone(),
        )
        .hyp_env("CHAINS_TEST2_MAXBATCHSIZE", "5")
        .hyp_env("CHAINS_TEST3_CONNECTION_URL", "http://127.0.0.1:8545")
        .hyp_env(
            "CHAINS_TEST3_BATCHCONTRACTADDRESS",
            multicall_address_string,
        )
        .hyp_env("CHAINS_TEST3_MAXBATCHSIZE", "5")
        .hyp_env("METRICSPORT", RELAYER_METRICS_PORT)
        .hyp_env("DB", relayer_db.to_str().unwrap())
        .hyp_env("CHAINS_TEST1_SIGNER_KEY", RELAYER_KEYS[0])
        .hyp_env("CHAINS_TEST2_SIGNER_KEY", RELAYER_KEYS[1])
        .hyp_env("RELAYCHAINS", "invalidchain,otherinvalid")
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env(
            "GASPAYMENTENFORCEMENT",
            r#"[{
                "type": "minimum",
                "payment": "1"
            }]"#,
        )
        .arg(
            "chains.test1.customRpcUrls",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        // default is used for TEST3
        .arg("defaultSigner.key", RELAYER_KEYS[2])
        .arg("relayChains", "test1,test2,test3")
}

fn stop_validator(state: &mut State, validator_index: usize) {
    let name = format!("VL{}", validator_index + 1);
    log!("Stopping validator {}...", name);
    let (child, _) = state
        .agents
        .get_mut(&name)
        .unwrap_or_else(|| panic!("Validator {} not found", name));
    child
        .kill()
        .unwrap_or_else(|_| panic!("Failed to stop validator {}", name));
    // Remove the validator from the state
    state.agents.remove(&name);
}

fn set_validator_reorg_flag(checkpoints_dirs: &[DynPath], validator_index: usize) {
    let reorg_event = ReorgEvent::default();

    let checkpoint_path = (*checkpoints_dirs[validator_index]).as_ref();
    let reorg_flag_path = checkpoint_path.join("reorg_flag.json");
    let mut reorg_flag_file =
        File::create(reorg_flag_path).expect("Failed to create reorg flag file");
    // Write to file
    let _ = reorg_flag_file
        .write(serde_json::to_string(&reorg_event).unwrap().as_bytes())
        .expect("Failed to write to reorg flag file");
}

/// Kills relayer in State and respawns the relayer again
fn restart_relayer(state: &mut State, rocks_db_dir: &TempDir) {
    log!("Stopping relayer...");
    let (child, _) = state.agents.get_mut("RLY").expect("No relayer agent found");
    child.kill().expect("Failed to stop relayer");

    log!("Restarting relayer...");
    let relayer_env = create_relayer(rocks_db_dir);
    state.push_agent(relayer_env.spawn("RLY", Some(&AGENT_LOGGING_DIR)));
    log!("Restarted relayer...");
}

fn relayer_reorg_handling_invariants_met() -> eyre::Result<bool> {
    let refused_messages = fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_submitter_queue_length",
        &HashMap::from([(
            "operation_status",
            PendingOperationStatus::Retry(ReprepareReason::MessageMetadataRefused)
                .to_string()
                .as_str(),
        )]),
    )?;
    if refused_messages.iter().sum::<u32>() == 0 {
        log!("Relayer still doesn't have any MessageMetadataRefused messages in the queue.");
        return Ok(false);
    };

    Ok(true)
}

/// Check relayer restart behaviour is correct.
/// So far, we only check if undelivered messages' statuses
/// are correctly retrieved from the database
fn relayer_restart_invariants_met() -> eyre::Result<bool> {
    let log_file_path = AGENT_LOGGING_DIR.join("RLY-output.log");
    let relayer_logfile = File::open(log_file_path).unwrap();

    let line_filters = vec![RETRIEVED_MESSAGE_LOG, "CouldNotFetchMetadata"];

    log!("Checking message statuses were retrieved from logs...");
    let matched_logs = get_matching_lines(&relayer_logfile, vec![line_filters.clone()]);

    let no_metadata_message_count = *matched_logs
        .get(&line_filters)
        .ok_or_else(|| eyre::eyre!("No logs matched line filters"))?;
    // These messages are never inserted into the merkle tree.
    // So these messages will never be deliverable and will always
    // be in a CouldNotFetchMetadata state.
    // When the relayer restarts, these messages' statuses should be
    // retrieved from the database with CouldNotFetchMetadata status.
    if no_metadata_message_count < ZERO_MERKLE_INSERTION_KATHY_MESSAGES {
        log!(
            "No metadata message count is {}, expected {}",
            no_metadata_message_count,
            ZERO_MERKLE_INSERTION_KATHY_MESSAGES
        );
        return Ok(false);
    }
    assert_eq!(
        no_metadata_message_count,
        ZERO_MERKLE_INSERTION_KATHY_MESSAGES
    );
    Ok(true)
}

/// Check relayer reused already built metadata
/// TODO: fix
#[allow(dead_code)]
fn relayer_cached_metadata_invariant_met() -> eyre::Result<bool> {
    let log_file_path = AGENT_LOGGING_DIR.join("RLY-output.log");
    let relayer_logfile = File::open(log_file_path).unwrap();

    let line_filters = vec![vec![INVALIDATE_CACHE_METADATA_LOG]];

    log!("Checking invalidate metadata cache happened...");
    let matched_logs = get_matching_lines(&relayer_logfile, line_filters.clone());

    log!("matched_logs: {:?}", matched_logs);

    let invalidate_metadata_cache_count = *matched_logs
        .get(&line_filters[0])
        .ok_or_else(|| eyre::eyre!("No logs matched line filters"))?;
    if invalidate_metadata_cache_count == 0 {
        log!(
            "Invalidate cache metadata reuse count is {}, expected non-zero value",
            invalidate_metadata_cache_count,
        );
        return Ok(false);
    }
    Ok(true)
}

pub fn wait_for_condition<F1, F2, F3>(
    config: &Config,
    start_time: Instant,
    condition_fn: F1,
    loop_invariant_fn: F2,
    mut shutdown_criteria_fn: F3,
) -> bool
where
    F1: Fn() -> eyre::Result<bool>,
    F2: Fn() -> bool,
    F3: FnMut() -> bool,
{
    let loop_check_interval = Duration::from_secs(5);
    while loop_invariant_fn() {
        log!("Checking e2e invariants...");
        sleep(loop_check_interval);
        if !config.ci_mode {
            continue;
        }
        match condition_fn() {
            Ok(true) => {
                // end condition reached successfully
                break;
            }
            Ok(false) => {
                log!("E2E invariants not met yet...");
            }
            Err(e) => {
                log!("Error checking e2e invariants: {}", e);
            }
        }
        if check_ci_timed_out(config.ci_mode_timeout, start_time) {
            // we ran out of time
            log!("Error: CI timeout reached before invariants were met");
            return false;
        }
        if shutdown_criteria_fn() {
            SHUTDOWN.store(true, Ordering::Relaxed);
            return false;
        }
    }
    true
}

/// check if CI has timed out based on config
fn check_ci_timed_out(timeout_secs: u64, start_time: Instant) -> bool {
    (Instant::now() - start_time).as_secs() > timeout_secs
}

/// verify long-running tasks are still running
fn long_running_processes_exited_check(state: &mut State) -> bool {
    for (name, (child, _)) in state.agents.iter_mut() {
        if let Some(status) = child.try_wait().unwrap() {
            if !status.success() {
                log!(
                    "Child process {} exited unexpectedly, with code {}. Shutting down",
                    name,
                    status.code().unwrap()
                );
                return true;
            }
        }
    }
    false
}

pub fn report_test_result(passed: bool) -> ExitCode {
    if passed {
        log!("E2E tests passed");
        ExitCode::SUCCESS
    } else {
        log!("E2E tests failed");
        ExitCode::FAILURE
    }
}
