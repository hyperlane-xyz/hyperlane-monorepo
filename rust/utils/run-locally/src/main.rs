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
//! - `E2E_KATHY_MESSAGES`: Number of kathy messages to dispatch. Defaults to 10 if CI mode is enabled.
//! - `E2E_LOG_ALL`: Log all output instead of writing to log files. Defaults to
//!   true if CI mode,
//! else false.

use std::{
    collections::HashMap,
    env,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    os::macos::raw::stat,
    path::{Path, PathBuf},
    process::{Child, Command, ExitCode, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread::{sleep, spawn, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use maplit::hashmap;
use nix::{
    libc::pid_t,
    sys::signal::{self, Signal},
    unistd::Pid,
};
use tempfile::tempdir;

/// These private keys are from hardhat/anvil's testing accounts.
const RELAYER_KEYS: &[&str] = &[
    "8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61",
    "f214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897",
    "701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82",
];
/// These private keys are from hardhat/anvil's testing accounts.
/// These must be consistent with the ISM config for the test.
const VALIDATOR_KEYS: &[&str] = &[
    "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];

static RUNNING: AtomicBool = AtomicBool::new(true);

/// Struct to hold stuff we want to cleanup whenever we exit. Just using for
/// cleanup purposes at this time.
#[derive(Default)]
struct State {
    kathy: Option<Child>,
    node: Option<Child>,
    relayer: Option<Child>,
    validators: Vec<Child>,
    scraper: Option<Child>,

    watchers: Vec<JoinHandle<()>>,
}

impl Drop for State {
    fn drop(&mut self) {
        println!("Signaling children to stop...");
        if let Some(mut c) = self.kathy.take() {
            stop_child(&mut c);
        }
        if let Some(mut c) = self.relayer.take() {
            stop_child(&mut c);
        }
        if let Some(mut c) = self.scraper.take() {
            stop_child(&mut c);
        }
        for mut c in self.validators.drain(..) {
            stop_child(&mut c);
        }
        if let Some(mut c) = self.node.take() {
            stop_child(&mut c);
        }
        println!("Joining watchers...");
        RUNNING.store(false, Ordering::Relaxed);
        for w in self.watchers.drain(..) {
            w.join().unwrap();
        }
    }
}

fn main() -> ExitCode {
    // on sigint we want to trigger things to stop running
    ctrlc::set_handler(|| {
        println!("Terminating...");
        RUNNING.store(false, Ordering::Relaxed);
    })
    .unwrap();

    let is_ci_env = env::var("CI").as_deref() == Ok("true");
    let ci_mode = env::var("E2E_CI_MODE")
        .map(|k| k.parse::<bool>().unwrap())
        .unwrap_or_default();

    let ci_mode_timeout = env::var("E2E_CI_TIMEOUT_SEC")
        .map(|k| k.parse::<u64>().unwrap())
        .unwrap_or(60 * 10);

    let kathy_messages = {
        let r = env::var("E2E_KATHY_MESSAGES")
            .ok()
            .map(|r| r.parse::<u64>().unwrap());
        r.unwrap_or(10)
    };

    let log_all = env::var("E2E_LOG_ALL")
        .map(|k| k.parse::<bool>().unwrap())
        .unwrap_or(ci_mode);

    let date_str = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();
    let log_dir = concat_path(env::temp_dir(), format!("logs/hyperlane-agents/{date_str}"));
    if !log_all {
        fs::create_dir_all(&log_dir).expect("Failed to make log dir");
    }
    let build_log = concat_path(&log_dir, "build.log");
    let hardhat_log = concat_path(&log_dir, "hardhat.stdout.log");

    let checkpoints_dirs = (0..3).map(|_| tempdir().unwrap()).collect::<Vec<_>>();
    let rocks_db_dir = tempdir().unwrap();
    let relayer_db = concat_path(&rocks_db_dir, "relayer");

    let common_env = hashmap! {
        "RUST_BACKTRACE" => "full",
        "HYP_BASE_TRACING_FMT" => "pretty",
        "HYP_BASE_TRACING_LEVEL" => "debug",
    };

    let relayer_env = hashmap! {
        "HYP_BASE_CHAINS_TEST1_CONNECTION_TYPE" => "httpFallback",
        "HYP_BASE_CHAINS_TEST2_CONNECTION_URLS" => "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        // by setting this as a quorum provider we will cause nonce errors when delivering to test2
        // because the message will be sent to the node 3 times.
        "HYP_BASE_CHAINS_TEST2_CONNECTION_TYPE" => "httpQuorum",
        "HYP_BASE_CHAINS_TEST3_CONNECTION_URL" => "http://127.0.0.1:8545",
        "HYP_BASE_METRICS" => "9092",
        "HYP_BASE_DB" => relayer_db.to_str().unwrap(),
        "HYP_BASE_CHAINS_TEST1_SIGNER_KEY" => RELAYER_KEYS[0],
        "HYP_BASE_CHAINS_TEST2_SIGNER_KEY" => RELAYER_KEYS[1],
        "HYP_BASE_RELAYCHAINS" => "invalidchain,otherinvalid",
        "HYP_RELAYER_ALLOWLOCALCHECKPOINTSYNCERS" => "true",
    };

    // test using args
    let relayer_args = [
        "--chains.test1.connection.urls=\"http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545\"",
        // default is used for TEST3
        "--defaultSigner.key", RELAYER_KEYS[2],
        "--relayChains=test1,test2,test3",
    ];

    let validator_envs: Vec<_> = (0..3).map(|i| {
        let metrics_port = make_static((9094 + i).to_string());
        let originchainname = make_static(format!("test{}", 1 + i));
        hashmap! {
            "HYP_BASE_CHAINS_TEST1_CONNECTION_URLS" => "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
            "HYP_BASE_CHAINS_TEST1_CONNECTION_TYPE" => "httpQuorum",
            "HYP_BASE_CHAINS_TEST2_CONNECTION_URLS" => "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
            "HYP_BASE_CHAINS_TEST2_CONNECTION_TYPE" => "httpFallback",
            "HYP_BASE_CHAINS_TEST3_CONNECTION_URL" => "http://127.0.0.1:8545",
            "HYP_BASE_METRICS" => metrics_port,
            "HYP_VALIDATOR_ORIGINCHAINNAME" => originchainname,
            "HYP_VALIDATOR_VALIDATOR_KEY" => VALIDATOR_KEYS[i],
            "HYP_VALIDATOR_REORGPERIOD" => "0",
            "HYP_VALIDATOR_INTERVAL" => "5",
            "HYP_VALIDATOR_CHECKPOINTSYNCER_TYPE" => "localStorage",
            "HYP_VALIDATOR_CHECKPOINTSYNCER_PATH" => checkpoints_dirs[i].path().to_str().unwrap(),
        }
    }).collect();

    let scraper_env = hashmap! {
        "HYP_BASE_CHAINS_TEST1_CONNECTION_TYPE" => "httpQuorum",
        "HYP_BASE_CHAINS_TEST1_CONNECTION_URL" => "http://127.0.0.1:8545",
        "HYP_BASE_CHAINS_TEST2_CONNECTION_TYPE" => "httpQuorum",
        "HYP_BASE_CHAINS_TEST2_CONNECTION_URL" => "http://127.0.0.1:8545",
        "HYP_BASE_CHAINS_TEST3_CONNECTION_TYPE" => "httpQuorum",
        "HYP_BASE_CHAINS_TEST3_CONNECTION_URL" => "http://127.0.0.1:8545",
        "HYP_BASE_CHAINSTOSCRAPE" => "test1,test2,test3",
        "HYP_BASE_METRICS" => "9093",
        "HYP_BASE_DB"=>"postgresql://postgres:47221c18c610@localhost:5432/postgres",
    };

    if !log_all {
        println!("Logs in {}", log_dir.display());
    }
    println!(
        "Signed checkpoints in {}",
        checkpoints_dirs
            .iter()
            .map(|d| d.path().display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!("Relayer DB in {}", relayer_db.display());

    let build_cmd = {
        let build_log = make_static(build_log.to_str().unwrap().into());
        move |cmd, path, env| build_cmd(cmd, build_log, log_all, path, env)
    };

    // this task takes a long time in the CI so run it in parallel
    let build_rust = {
        spawn(move || {
            println!("Building rust...");
            build_cmd(
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
        })
    };

    println!("Running postgres db...");
    let postgres_env = hashmap! {
        "DATABASE_URL"=>"postgresql://postgres:47221c18c610@localhost:5432/postgres",
    };
    build_cmd(
        &[
            "docker",
            "run",
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
    );

    println!("Installing typescript dependencies...");
    build_cmd(&["yarn", "install"], Some("../"), None);
    if !is_ci_env {
        // don't need to clean in the CI
        build_cmd(&["yarn", "clean"], Some("../"), None);
    }
    build_cmd(&["yarn", "build:e2e"], Some("../"), None);

    let mut state = State::default();

    println!("Launching hardhat...");
    let mut node = Command::new("yarn");
    node.args(["hardhat", "node"])
        .current_dir("../typescript/infra");
    if log_all {
        // TODO: should we log this? It seems way too verbose to be useful
        // node.stdout(Stdio::piped());
        node.stdout(Stdio::null());
    } else {
        node.stdout(append_to(hardhat_log));
    }
    let node = node.spawn().expect("Failed to start node");
    state.node = Some(node);

    sleep(Duration::from_secs(10));

    println!("Deploying hyperlane ism contracts...");
    build_cmd(&["yarn", "deploy-ism"], Some("../typescript/infra"), None);

    println!("Rebuilding sdk...");
    build_cmd(&["yarn", "build"], Some("../typescript/sdk"), None);

    println!("Deploying hyperlane core contracts...");
    build_cmd(&["yarn", "deploy-core"], Some("../typescript/infra"), None);

    println!("Deploying hyperlane igp contracts...");
    build_cmd(&["yarn", "deploy-igp"], Some("../typescript/infra"), None);

    if !is_ci_env {
        // Follow-up 'yarn hardhat node' invocation with 'yarn prettier' to fixup
        // formatting on any autogenerated json config files to avoid any diff creation.
        build_cmd(&["yarn", "prettier"], Some("../"), None);
    }

    // Rebuild the SDK to pick up the deployed contracts
    println!("Rebuilding sdk...");
    build_cmd(&["yarn", "build"], Some("../typescript/sdk"), None);

    build_rust.join().unwrap();

    println!("Init postgres db...");
    build_cmd(
        &["cargo", "run", "-r", "-p", "migration", "--bin", "init-db"],
        None,
        None,
    );

    let (scraper, scraper_stdout, scraper_stderr) = run_agent(
        "scraper",
        &scraper_env.into_iter().chain(common_env.clone()).collect(),
        &[],
        "SCR",
        log_all,
        &log_dir,
    );
    state.watchers.push(scraper_stdout);
    state.watchers.push(scraper_stderr);
    state.scraper = Some(scraper);

    for (i, validator_env) in validator_envs.iter().enumerate() {
        let (validator, validator_stdout, validator_stderr) = run_agent(
            "validator",
            &common_env
                .clone()
                .into_iter()
                .chain(validator_env.clone())
                .collect(),
            &[],
            make_static(format!("VAL{}", 1 + i)),
            log_all,
            &log_dir,
        );
        state.watchers.push(validator_stdout);
        state.watchers.push(validator_stderr);
        state.validators.push(validator);
    }

    // Run one round of kathy before the relayer comes up
    let mut kathy = Command::new("yarn");
    kathy
        .arg("kathy")
        .args([
            "--messages",
            &kathy_messages.to_string(),
            "--timeout",
            "1000",
        ])
        .current_dir("../typescript/infra")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (mut kathy, kathy_stdout, kathy_stderr) =
        spawn_cmd_with_logging("kathy", kathy, "KTY", log_all, &log_dir);
    state.watchers.push(kathy_stdout);
    state.watchers.push(kathy_stderr);
    kathy.wait().unwrap();

    let (relayer, relayer_stdout, relayer_stderr) = run_agent(
        "relayer",
        &relayer_env.into_iter().chain(common_env.clone()).collect(),
        &relayer_args,
        "RLY",
        log_all,
        &log_dir,
    );
    state.watchers.push(relayer_stdout);
    state.watchers.push(relayer_stderr);
    state.relayer = Some(relayer);

    println!("Setup complete! Agents running in background...");
    println!("Ctrl+C to end execution...");

    let mut kathy = Command::new("yarn");
    kathy
        .arg("kathy")
        .args([
            "--messages",
            &kathy_messages.to_string(),
            "--timeout",
            "1000",
        ])
        .current_dir("../typescript/infra")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (kathy, kathy_stdout, kathy_stderr) =
        spawn_cmd_with_logging("kathy", kathy, "KTY", log_all, &log_dir);
    state.watchers.push(kathy_stdout);
    state.watchers.push(kathy_stderr);
    state.kathy = Some(kathy);

    let loop_start = Instant::now();
    // give things a chance to fully start.
    sleep(Duration::from_secs(5));
    let mut kathy_done = false;
    while RUNNING.fetch_and(true, Ordering::Relaxed) {
        if !kathy_done {
            // check if kathy has finished
            match state.kathy.as_mut().unwrap().try_wait().unwrap() {
                Some(s) if s.success() => {
                    kathy_done = true;
                }
                Some(_) => {
                    return ExitCode::from(1);
                }
                None => {}
            }
        }
        if ci_mode {
            // for CI we have to look for the end condition.
            let num_messages_expected = kathy_messages as u32 * 2;
            if kathy_done && termination_invariants_met(num_messages_expected) {
                // end condition reached successfully
                println!("Kathy completed successfully and the retry queues are empty");
                break;
            } else if (Instant::now() - loop_start).as_secs() > ci_mode_timeout {
                // we ran out of time
                eprintln!("CI timeout reached before queues emptied and or kathy finished.");
                return ExitCode::from(1);
            }
        } else if kathy_done {
            // when not in CI mode, run until kathy finishes, which should only happen if a
            // number of rounds is specified.
            break;
        }
        sleep(Duration::from_secs(5));
    }
    // TODO: Remove me!
    loop {
        sleep(Duration::from_secs(10));
    }

    ExitCode::from(0)
}

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent.
fn termination_invariants_met(num_expected_messages_processed: u32) -> bool {
    let lengths: Vec<_> = ureq::get("http://127.0.0.1:9092/metrics")
        .call()
        .unwrap()
        .into_string()
        .unwrap()
        .lines()
        .filter(|l| l.starts_with("hyperlane_submitter_queue_length"))
        .filter(|l| !l.contains("queue_name=\"confirm_queue\""))
        .map(|l| l.rsplit_once(' ').unwrap().1.parse::<u32>().unwrap())
        .collect();
    assert!(!lengths.is_empty(), "Could not find queue length metric");
    if lengths.into_iter().any(|n| n != 0) {
        println!("<E2E> Relayer queues not empty");
        return false;
    };

    // Also ensure the counter is as expected (total number of messages), summed
    // across all mailboxes.
    let msg_processed_count: Vec<_> = ureq::get("http://127.0.0.1:9092/metrics")
        .call()
        .unwrap()
        .into_string()
        .unwrap()
        .lines()
        .filter(|l| l.starts_with("hyperlane_messages_processed_count"))
        .map(|l| l.rsplit_once(' ').unwrap().1.parse::<u32>().unwrap())
        .collect();
    assert!(
        !msg_processed_count.is_empty(),
        "Could not find message_processed phase metric"
    );
    if msg_processed_count.into_iter().sum::<u32>() < num_expected_messages_processed {
        println!("<E2E> Not all messages have been processed");
        return false;
    }

    let gas_payment_events_count = ureq::get("http://127.0.0.1:9092/metrics")
        .call()
        .unwrap()
        .into_string()
        .unwrap()
        .lines()
        .filter(|l| l.starts_with("hyperlane_contract_sync_stored_events"))
        .filter(|l| l.contains(r#"data_type="gas_payments""#))
        .map(|l| l.rsplit_once(' ').unwrap().1.parse::<u32>().unwrap())
        .sum::<u32>();

    if gas_payment_events_count < num_expected_messages_processed {
        println!("<E2E> Missing gas payment events");
        false
    } else {
        true
    }
}

/// Read from a process output and add a string to the front before writing it
/// to stdout.
fn prefix_log(output: impl Read, name: &'static str) {
    let mut reader = BufReader::new(output).lines();
    loop {
        if let Some(line) = reader.next() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    // end of stream, probably
                    eprintln!("Error reading from output for {name}: {e}");
                    break;
                }
            };
            println!("<{name}> {line}");
        } else if RUNNING.fetch_and(true, Ordering::Relaxed) {
            sleep(Duration::from_millis(10));
        } else {
            break;
        }
    }
}

/// Basically `tail -f file | grep <FILTER>` but also has to write to the file
/// (writes to file all lines, not just what passes the filter).
fn inspect_and_write_to_file(output: impl Read, log: impl AsRef<Path>, filter_array: &[&str]) {
    let mut writer = BufWriter::new(append_to(log));
    let mut reader = BufReader::new(output).lines();
    loop {
        if let Some(line) = reader.next() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    // end of stream, probably
                    eprintln!("Error reading from output: {e}");
                    break;
                }
            };

            if filter_array.is_empty() {
                println!("{line}")
            } else {
                for filter in filter_array {
                    if line.contains(filter) {
                        println!("{line}")
                    }
                }
            }
            writeln!(writer, "{line}").unwrap();
        } else if RUNNING.fetch_and(true, Ordering::Relaxed) {
            sleep(Duration::from_millis(10))
        } else {
            break;
        }
    }
}

/// Attempt to kindly signal a child to stop running, and kill it if that fails.
fn stop_child(child: &mut Child) {
    if child.try_wait().unwrap().is_some() {
        // already stopped
        return;
    }
    let pid = Pid::from_raw(child.id() as pid_t);
    if signal::kill(pid, Signal::SIGTERM).is_err() {
        eprintln!("Failed to send sigterm, killing");
        if let Err(e) = child.kill() {
            eprintln!("{}", e);
        }
    };
}

/// Merge two paths.
fn concat_path(p1: impl AsRef<Path>, p2: impl AsRef<Path>) -> PathBuf {
    let mut p = p1.as_ref().to_path_buf();
    p.push(p2);
    p
}

/// Open a file in append mode, or create it if it does not exist.
fn append_to(p: impl AsRef<Path>) -> File {
    File::options()
        .create(true)
        .append(true)
        .open(p)
        .expect("Failed to open file")
}

fn build_cmd(
    cmd: &[&str],
    log: impl AsRef<Path>,
    log_all: bool,
    wd: Option<&str>,
    env: Option<&HashMap<&str, &str>>,
) {
    assert!(!cmd.is_empty(), "Must specify a command!");
    let mut c = Command::new(cmd[0]);
    c.args(&cmd[1..]);
    if log_all {
        c.stdout(Stdio::inherit());
    } else {
        c.stdout(append_to(log));
    }
    if let Some(wd) = wd {
        c.current_dir(wd);
    }
    let status = c.status().expect("Failed to run command");
    assert!(
        status.success(),
        "Command returned non-zero exit code: {}",
        cmd.join(" ")
    );
}

fn make_static(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn spawn_cmd_with_logging(
    name: &str,
    mut command: Command,
    log_prefix: &'static str,
    log_all: bool,
    log_dir: &PathBuf,
) -> (std::process::Child, JoinHandle<()>, JoinHandle<()>) {
    println!("Spawning {}...", name);
    let mut child = command.spawn().expect(&format!("Failed to start {}", name));
    let stdout_path = concat_path(log_dir, format!("{}.stdout.log", log_prefix));
    let child_stdout = child.stdout.take().unwrap();
    let stdout = spawn(move || {
        if log_all {
            prefix_log(child_stdout, &log_prefix.clone())
        } else {
            inspect_and_write_to_file(
                child_stdout,
                stdout_path,
                &["ERROR", "message successfully processed"],
            )
        }
    });
    let stderr_path = concat_path(log_dir, format!("{}.stderr.log", log_prefix));
    let child_stderr = child.stderr.take().unwrap();
    let stderr = spawn(move || {
        if log_all {
            prefix_log(child_stderr, &log_prefix.clone())
        } else {
            inspect_and_write_to_file(child_stderr, stderr_path, &[])
        }
    });
    (child, stdout, stderr)
}

fn run_agent(
    name: &str,
    env: &HashMap<&str, &str>,
    args: &[&str],
    log_prefix: &'static str,
    log_all: bool,
    log_dir: &PathBuf,
) -> (std::process::Child, JoinHandle<()>, JoinHandle<()>) {
    let mut command = Command::new(format!("target/debug/{}", name));
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(env)
        .args(args);
    spawn_cmd_with_logging(name, command, log_prefix, log_all, log_dir)
}
