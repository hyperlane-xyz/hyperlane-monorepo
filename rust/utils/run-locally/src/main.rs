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
//! - `E2E_LOG_ALL`: Log all output instead of writing to log files. Defaults to
//!   true if CI mode,
//! else false.

use std::path::Path;
use std::{
    collections::HashMap,
    env,
    fs::{self},
    path::PathBuf,
    process::{Child, Command, ExitCode, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread::{sleep, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use eyre::{eyre, Result};
use maplit::hashmap;
use tempfile::tempdir;

use logging::log;

use crate::config::ProgramArgs;
use crate::utils::{append_to, build_cmd, concat_path, make_static, run_agent, stop_child};

mod config;
mod logging;
mod utils;

/// These private keys are from hardhat/anvil's testing accounts.
const RELAYER_KEYS: &[&str] = &[
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
];
/// These private keys are from hardhat/anvil's testing accounts.
/// These must be consistent with the ISM config for the test.
const VALIDATOR_KEYS: &[&str] = &[
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
];

const AGENT_BIN_PATH: &str = "target/debug";
const INFRA_PATH: &str = "../typescript/infra";
const TS_SDK_PATH: &str = "../typescript/sdk";
const MONOREPO_ROOT_PATH: &str = "../";

static RUN_LOG_WATCHERS: AtomicBool = AtomicBool::new(true);
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// Struct to hold stuff we want to cleanup whenever we exit. Just using for
/// cleanup purposes at this time.
#[derive(Default)]
struct State {
    build_log: PathBuf,
    log_all: bool,
    scraper_postgres_initialized: bool,
    agents: Vec<Child>,
    watchers: Vec<JoinHandle<()>>,
}

impl Drop for State {
    fn drop(&mut self) {
        SHUTDOWN.store(true, Ordering::Relaxed);
        log!("Signaling children to stop...");
        // stop children in reverse order
        self.agents.reverse();
        for mut agent in self.agents.drain(..) {
            stop_child(&mut agent);
        }
        if self.scraper_postgres_initialized {
            log!("Stopping scraper postgres...");
            kill_scraper_postgres(&self.build_log, self.log_all);
        }
        log!("Joining watchers...");
        RUN_LOG_WATCHERS.store(false, Ordering::Relaxed);
        for w in self.watchers.drain(..) {
            w.join().unwrap();
        }
    }
}

fn main() -> ExitCode {
    macro_rules! shutdown_if_needed {
        () => {
            if SHUTDOWN.load(Ordering::Relaxed) {
                log!("Early termination, shutting down");
                return ExitCode::FAILURE;
            }
        };
    }

    // on sigint we want to trigger things to stop running
    ctrlc::set_handler(|| {
        log!("Terminating...");
        SHUTDOWN.store(true, Ordering::Relaxed);
    })
    .unwrap();

    let config = config::Config::load();

    let date_str = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();
    let log_dir = concat_path(env::temp_dir(), format!("logs/hyperlane-agents/{date_str}"));
    if !config.log_all {
        fs::create_dir_all(&log_dir).expect("Failed to make log dir");
    }
    let build_log = concat_path(&log_dir, "build.log");
    let anvil_log = concat_path(&log_dir, "anvil.stdout.log");

    let checkpoints_dirs = (0..3).map(|_| tempdir().unwrap()).collect::<Vec<_>>();
    let rocks_db_dir = tempdir().unwrap();
    let relayer_db = concat_path(&rocks_db_dir, "relayer");
    let validator_dbs = (0..3)
        .map(|i| concat_path(&rocks_db_dir, format!("validator{i}")))
        .collect::<Vec<_>>();

    let scraper_bin = concat_path(AGENT_BIN_PATH, "scraper");
    let validator_bin = concat_path(AGENT_BIN_PATH, "validator");
    let relayer_bin = concat_path(AGENT_BIN_PATH, "relayer");

    let common_agent_env = ProgramArgs::default()
        .sys_env("RUST_BACKTRACE", "full")
        .env("TRACING_FMT", "pretty")
        .env("TRACING_LEVEL", "debug")
        .env("CHAINS_TEST1_INDEX_CHUNK", "1")
        .env("CHAINS_TEST2_INDEX_CHUNK", "1")
        .env("CHAINS_TEST3_INDEX_CHUNK", "1");

    let relayer_env = common_agent_env
        .clone()
        .env("CHAINS_TEST1_CONNECTION_TYPE", "httpFallback")
        .env(
            "CHAINS_TEST2_CONNECTION_URLS",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        // by setting this as a quorum provider we will cause nonce errors when delivering to test2
        // because the message will be sent to the node 3 times.
        .env("CHAINS_TEST2_CONNECTION_TYPE", "httpQuorum")
        .env("CHAINS_TEST3_CONNECTION_URL", "http://127.0.0.1:8545")
        .env("METRICS", "9092")
        .env("DB", relayer_db.to_str().unwrap())
        .env("CHAINS_TEST1_SIGNER_KEY", RELAYER_KEYS[0])
        .env("CHAINS_TEST2_SIGNER_KEY", RELAYER_KEYS[1])
        .env("RELAYCHAINS", "invalidchain,otherinvalid")
        .env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .arg(
            "chains.test1.connection.urls",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        // default is used for TEST3
        .arg("defaultSigner.key", RELAYER_KEYS[2])
        .arg("relayChains", "test1,test2,test3");

    let base_validator_env = common_agent_env
        .clone()
        .env(
            "CHAINS_TEST1_CONNECTION_URLS",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        .env("CHAINS_TEST1_CONNECTION_TYPE", "httpQuorum")
        .env(
            "CHAINS_TEST2_CONNECTION_URLS",
            "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        )
        .env("CHAINS_TEST2_CONNECTION_TYPE", "httpFallback")
        .env("CHAINS_TEST3_CONNECTION_URL", "http://127.0.0.1:8545")
        .env("REORGPERIOD", "0")
        .env("INTERVAL", "5")
        .env("CHECKPOINTSYNCER_TYPE", "localStorage");

    let validator_envs = (0..3)
        .map(|i| {
            base_validator_env
                .clone()
                .env("METRICS", (9094 + i).to_string())
                .env("DB", validator_dbs[i].to_str().unwrap())
                .env("ORIGINCHAINNAME", format!("test{}", 1 + i))
                .env("VALIDATOR_KEY", VALIDATOR_KEYS[i])
                .env(
                    "CHECKPOINTSYNCER_PATH",
                    checkpoints_dirs[i].path().to_str().unwrap(),
                )
        })
        .collect::<Vec<_>>();

    let scraper_env = common_agent_env
        .env("CHAINS_TEST1_CONNECTION_TYPE", "httpQuorum")
        .env("CHAINS_TEST1_CONNECTION_URL", "http://127.0.0.1:8545")
        .env("CHAINS_TEST2_CONNECTION_TYPE", "httpQuorum")
        .env("CHAINS_TEST2_CONNECTION_URL", "http://127.0.0.1:8545")
        .env("CHAINS_TEST3_CONNECTION_TYPE", "httpQuorum")
        .env("CHAINS_TEST3_CONNECTION_URL", "http://127.0.0.1:8545")
        .env("CHAINSTOSCRAPE", "test1,test2,test3")
        .env("METRICS", "9093")
        .env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        );

    let mut state = State::default();
    state.build_log = build_log;
    state.log_all = config.log_all;

    if !config.log_all {
        log!("Logs in {}", log_dir.display());
    }
    log!(
        "Signed checkpoints in {}",
        checkpoints_dirs
            .iter()
            .map(|d| d.path().display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    log!("Relayer DB in {}", relayer_db.display());
    (0..3).for_each(|i| {
        log!("Validator {} DB in {}", i + 1, validator_dbs[i].display());
    });

    let build_log_ref = make_static(state.build_log.to_str().unwrap().to_owned());
    let build_cmd =
        move |cmd, path, env| build_cmd(cmd, build_log_ref, config.log_all, path, env, true);

    shutdown_if_needed!();
    // this task takes a long time in the CI so run it in parallel
    log!("Building rust...");
    let build_rust = build_cmd(
        &[
            "cargo",
            "build",
            "--features",
            "test-utils",
            "--bin",
            "relayer",
            "--bin",
            "validator",
            "--bin",
            "scraper",
            "--bin",
            "init-db",
        ],
        None,
        None,
    );

    log!("Running postgres db...");
    let postgres_env = hashmap! {
        "DATABASE_URL"=>"postgresql://postgres:47221c18c610@localhost:5432/postgres",
    };
    kill_scraper_postgres(&state.build_log, config.log_all);
    build_cmd(
        &[
            "docker",
            "run",
            "--rm",
            "--name",
            "scraper-testnet-postgres",
            "-e",
            "POSTGRES_PASSWORD=47221c18c610",
            "-p",
            "5432:5432",
            "-d",
            "postgres:14",
        ],
        None,
        Some(&postgres_env),
    )
    .join();
    state.scraper_postgres_initialized = true;

    shutdown_if_needed!();
    log!("Installing typescript dependencies...");
    build_cmd(&["yarn", "install"], Some(&MONOREPO_ROOT_PATH), None).join();
    if !config.is_ci_env {
        // don't need to clean in the CI
        build_cmd(&["yarn", "clean"], Some(&MONOREPO_ROOT_PATH), None).join();
    }
    shutdown_if_needed!();
    build_cmd(&["yarn", "build"], Some(&MONOREPO_ROOT_PATH), None).join();

    shutdown_if_needed!();
    log!("Launching anvil...");
    let mut node = Command::new("anvil");
    if config.log_all {
        // TODO: should we log this? It seems way too verbose to be useful
        // node.stdout(Stdio::piped());
        node.stdout(Stdio::null());
    } else {
        node.stdout(append_to(anvil_log));
    }
    let node = node.spawn().expect("Failed to start node");
    state.agents.push(node);

    sleep(Duration::from_secs(10));

    let deploy_env = hashmap! {"ALLOW_LEGACY_MULTISIG_ISM" => "true"};
    log!("Deploying hyperlane ism contracts...");
    build_cmd(
        &["yarn", "deploy-ism"],
        Some(&INFRA_PATH),
        Some(&deploy_env),
    )
    .join();

    shutdown_if_needed!();
    log!("Rebuilding sdk...");
    build_cmd(&["yarn", "build"], Some(&TS_SDK_PATH), None).join();

    log!("Deploying hyperlane core contracts...");
    build_cmd(
        &["yarn", "deploy-core"],
        Some(&INFRA_PATH),
        Some(&deploy_env),
    )
    .join();

    log!("Deploying hyperlane igp contracts...");
    build_cmd(
        &["yarn", "deploy-igp"],
        Some(&INFRA_PATH),
        Some(&deploy_env),
    )
    .join();

    if !config.is_ci_env {
        // Follow-up 'yarn hardhat node' invocation with 'yarn prettier' to fixup
        // formatting on any autogenerated json config files to avoid any diff creation.
        build_cmd(&["yarn", "prettier"], Some(&MONOREPO_ROOT_PATH), None).join();
    }

    shutdown_if_needed!();
    // Rebuild the SDK to pick up the deployed contracts
    log!("Rebuilding sdk...");
    build_cmd(&["yarn", "build"], Some(&TS_SDK_PATH), None).join();

    build_rust.join();

    log!("Init postgres db...");
    build_cmd(
        &["cargo", "run", "-r", "-p", "migration", "--bin", "init-db"],
        None,
        None,
    )
    .join();

    shutdown_if_needed!();

    let (scraper, scraper_stdout, scraper_stderr) =
        run_agent(scraper_bin, &scraper_env, "SCR", config.log_all, &log_dir);
    state.watchers.push(scraper_stdout);
    state.watchers.push(scraper_stderr);
    state.agents.push(scraper);

    // spawn 1st validator before any messages have been sent to test empty mailbox
    let validator1_env = validator_envs.first().unwrap();
    let (validator, validator_stdout, validator_stderr) = run_agent(
        &validator_bin,
        validator1_env,
        "VAL1",
        config.log_all,
        &log_dir,
    );
    state.watchers.push(validator_stdout);
    state.watchers.push(validator_stderr);
    state.agents.push(validator);

    sleep(Duration::from_secs(5));

    // Send half the kathy messages before starting the rest of the agents
    let kathy_env = ProgramArgs::default()
        .working_dir(INFRA_PATH)
        .raw_arg("kathy")
        .arg("messages", (config.kathy_messages / 2).to_string())
        .arg("timeout", "1000");
    let (mut kathy, kathy_stdout, kathy_stderr) =
        run_agent("yarn", &kathy_env, "KTY", config.log_all, &log_dir);
    state.watchers.push(kathy_stdout);
    state.watchers.push(kathy_stderr);
    kathy.wait().unwrap();

    // spawn the rest of the validators
    for (i, validator_env) in validator_envs.iter().enumerate().skip(1) {
        let (validator, validator_stdout, validator_stderr) = run_agent(
            &validator_bin,
            validator_env,
            make_static(format!("VAL{}", 1 + i)),
            config.log_all,
            &log_dir,
        );
        state.watchers.push(validator_stdout);
        state.watchers.push(validator_stderr);
        state.agents.push(validator);
    }

    let (relayer, relayer_stdout, relayer_stderr) =
        run_agent(relayer_bin, &relayer_env, "RLY", config.log_all, &log_dir);
    state.watchers.push(relayer_stdout);
    state.watchers.push(relayer_stderr);
    state.agents.push(relayer);

    log!("Setup complete! Agents running in background...");
    log!("Ctrl+C to end execution...");

    // Send half the kathy messages after the relayer comes up
    let kathy_env = kathy_env.raw_arg("--mineforever");
    let (kathy, kathy_stdout, kathy_stderr) =
        run_agent("yarn", &kathy_env, "KTY", config.log_all, &log_dir);
    state.watchers.push(kathy_stdout);
    state.watchers.push(kathy_stderr);
    state.agents.push(kathy);

    let loop_start = Instant::now();
    // give things a chance to fully start.
    sleep(Duration::from_secs(5));
    let mut failure_occurred = false;
    while !SHUTDOWN.load(Ordering::Relaxed) {
        if config.ci_mode {
            // for CI we have to look for the end condition.
            let num_messages_expected = (config.kathy_messages / 2) as u32 * 2;
            if termination_invariants_met(num_messages_expected).unwrap_or(false) {
                // end condition reached successfully
                log!("Agent metrics look healthy");
                break;
            } else if (Instant::now() - loop_start).as_secs() > config.ci_mode_timeout {
                // we ran out of time
                log!("CI timeout reached before queues emptied");
                failure_occurred = true;
                break;
            }
        }

        // verify long-running tasks are still running
        for child in state.agents.iter_mut() {
            if child.try_wait().unwrap().is_some() {
                log!("Child process exited unexpectedly, shutting down");
                failure_occurred = true;
                break;
            }
        }

        sleep(Duration::from_secs(5));
    }

    if failure_occurred {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn fetch_metric(port: &str, metric: &str, labels: &HashMap<&str, &str>) -> Result<Vec<u32>> {
    let resp = ureq::get(&format!("http://127.0.0.1:{}/metrics", port));
    resp.call()?
        .into_string()?
        .lines()
        .filter(|l| l.starts_with(metric))
        .filter(|l| {
            labels
                .iter()
                .all(|(k, v)| l.contains(&format!("{k}=\"{v}\"")))
        })
        .map(|l| {
            Ok(l.rsplit_once(' ')
                .ok_or(eyre!("Unknown metric format"))?
                .1
                .parse::<u32>()?)
        })
        .collect()
}

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent.
fn termination_invariants_met(num_expected_messages: u32) -> Result<bool> {
    let lengths = fetch_metric("9092", "hyperlane_submitter_queue_length", &hashmap! {})?;
    assert!(!lengths.is_empty(), "Could not find queue length metric");
    if lengths.into_iter().any(|n| n != 0) {
        log!("Relayer queues not empty");
        return Ok(false);
    };

    // Also ensure the counter is as expected (total number of messages), summed
    // across all mailboxes.
    let msg_processed_count =
        fetch_metric("9092", "hyperlane_messages_processed_count", &hashmap! {})?
            .iter()
            .sum::<u32>();
    if msg_processed_count != num_expected_messages {
        log!(
            "Relayer has {} processed messages, expected {}",
            msg_processed_count,
            num_expected_messages
        );
        return Ok(false);
    }

    let gas_payment_events_count = fetch_metric(
        "9092",
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payments"},
    )?
    .iter()
    .sum::<u32>();
    // TestSendReceiver randomly breaks gas payments up into
    // two. So we expect at least as many gas payments as messages.
    if gas_payment_events_count < num_expected_messages {
        log!(
            "Relayer has {} gas payment events, expected at least {}",
            gas_payment_events_count,
            num_expected_messages
        );
        return Ok(false);
    }

    let dispatched_messages_scraped = fetch_metric(
        "9093",
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_dispatch"},
    )?
    .iter()
    .sum::<u32>();
    if dispatched_messages_scraped != num_expected_messages {
        log!(
            "Scraper has scraped {} dispatched messages, expected {}",
            dispatched_messages_scraped,
            num_expected_messages
        );
        return Ok(false);
    }

    let gas_payments_scraped = fetch_metric(
        "9093",
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();
    // The relayer and scraper should have the same number of gas payments.
    if gas_payments_scraped != gas_payment_events_count {
        log!(
            "Scraper has scraped {} gas payments, expected {}",
            gas_payments_scraped,
            num_expected_messages
        );
        return Ok(false);
    }

    let delivered_messages_scraped = fetch_metric(
        "9093",
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_delivery"},
    )?
    .iter()
    .sum::<u32>();
    if delivered_messages_scraped != num_expected_messages {
        log!(
            "Scraper has scraped {} delivered messages, expected {}",
            delivered_messages_scraped,
            num_expected_messages
        );
        Ok(false)
    } else {
        log!("Termination invariants have been meet");
        Ok(true)
    }
}

fn kill_scraper_postgres(build_log: impl AsRef<Path>, log_all: bool) {
    build_cmd(
        &["docker", "stop", "scraper-testnet-postgres"],
        &build_log,
        log_all,
        None,
        None,
        false,
    )
    .join();
}
