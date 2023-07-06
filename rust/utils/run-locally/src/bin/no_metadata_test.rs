//! Run this from the hyperlane-monorepo/rust directory using `cargo run -r -p
//! run-locally`.
//!
//! Environment arguments:
//! - `E2E_CI_MODE`: true/false, enables CI mode which will automatically wait
//!   for hook messages to finish
//! running and for the queues to empty. Defaults to false.
//! - `E2E_CI_TIMEOUT_SEC`: How long (in seconds) to allow the main loop to run
//!   the test for. This
//! does not include the initial setup time. If this timeout is reached before
//! the end conditions are met, the test is a failure. Defaults to 10 min.
//! - `E2E_HOOK_MESSAGES`: Number of hook messages to dispatch. Defaults to 16 if CI mode is enabled.
//! - `E2E_LOG_ALL`: Log all output instead of writing to log files. Defaults to
//!   true if CI mode,
//! else false.

use std::{
    collections::HashMap,
    env,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitCode, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread::{sleep, spawn, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use eyre::Result;
use maplit::hashmap;
use nix::{
    libc::pid_t,
    sys::signal::{self, Signal},
    unistd::Pid,
};
use tempfile::tempdir;

/// These private keys are from hardhat/anvil's testing accounts.
const RELAYER_KEYS: &[&str] = &[
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
];

static RUNNING: AtomicBool = AtomicBool::new(true);

/// Struct to hold stuff we want to cleanup whenever we exit. Just using for
/// cleanup purposes at this time.
#[derive(Default)]
struct State {
    build_log: PathBuf,
    log_all: bool,
    l1_node: Option<Child>,
    l2_node: Option<Child>,
    relayer: Option<Child>,

    watchers: Vec<JoinHandle<()>>,
}

impl Drop for State {
    fn drop(&mut self) {
        if let Some(mut c) = self.relayer.take() {
            stop_child(&mut c);
        }
        if let Some(mut c) = self.l1_node.take() {
            stop_child(&mut c);
        }
        if let Some(mut c) = self.l2_node.take() {
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

    let hook_messages = {
        let r = env::var("E2E_HOOK_MESSAGES")
            .ok()
            .map(|r| r.parse::<u64>().unwrap());
        r.unwrap_or(16)
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
    let anvil_log = concat_path(&log_dir, "anvil.stdout.log");

    let rocks_db_dir = tempdir().unwrap();
    let relayer_db = concat_path(&rocks_db_dir, "relayer");

    let common_env = hashmap! {
        "RUST_BACKTRACE" => "full",
        "HYP_BASE_TRACING_FMT" => "pretty",
        "HYP_BASE_TRACING_LEVEL" => "debug",
        "HYP_BASE_CHAINS_ETHEREUM_INDEX_CHUNK" => "1",
        "HYP_BASE_CHAINS_OPTIMISM_INDEX_CHUNK" => "1",
    };

    // let common_env = hashmap! {
    //     "RUST_BACKTRACE" => "full",
    //     "HYP_BASE_TRACING_FMT" => "pretty",
    //     "HYP_BASE_TRACING_LEVEL" => "debug",
    //     "HYP_BASE_CHAINS_TEST1_INDEX_CHUNK" => "1",
    //     "HYP_BASE_CHAINS_TEST2_INDEX_CHUNK" => "1",
    // };

    let relayer_env = hashmap! {
        "HYP_BASE_CHAINS_ETHEREUM_CONNECTION_TYPE" => "http",
        "HYP_BASE_CHAINS_OPTIMISM_CONNECTION_TYPE" => "http",
        "HYP_BASE_METRICS" => "9092",
        "HYP_BASE_DB" => relayer_db.to_str().unwrap(),
        "HYP_BASE_CHAINS_ETHEREUM_SIGNER_KEY" => RELAYER_KEYS[0],
        "HYP_BASE_CHAINS_OPTIMISM_SIGNER_KEY" => RELAYER_KEYS[1],
        "HYP_BASE_RELAYCHAINS" => "ethereum,optimism",
        "HYP_RELAYER_ALLOWLOCALCHECKPOINTSYNCERS" => "true",
    };

    // let relayer_env = hashmap! {
    //     "HYP_BASE_CHAINS_TEST1_CONNECTION_TYPE" => "http",
    //     "HYP_BASE_CHAINS_TEST2_CONNECTION_TYPE" => "http",
    //     "HYP_BASE_METRICS" => "9092",
    //     "HYP_BASE_DB" => relayer_db.to_str().unwrap(),
    //     "HYP_BASE_CHAINS_TEST1_SIGNER_KEY" => RELAYER_KEYS[0],
    //     "HYP_BASE_CHAINS_TEST2_SIGNER_KEY" => RELAYER_KEYS[1],
    //     "HYP_BASE_RELAYCHAINS" => "test1,test2",
    //     "HYP_RELAYER_ALLOWLOCALCHECKPOINTSYNCERS" => "true",
    // };

    // test using args
    let relayer_args = [
        "--chains.ethereum.connection.url=\"http://127.0.0.1:8546\"",
        "--chains.optimism.connection.url=\"http://127.0.0.1:8547\"",
        // default is used for TEST3
        "--defaultSigner.key", RELAYER_KEYS[2],
        "--relayChains=ethereum,optimism",
    ];

    // let relayer_args = [
    //     "--chains.test1.connection.url=\"http://127.0.0.1:8546\"",
    //     "--chains.test2.connection.url=\"http://127.0.0.1:8547\"",
    //     // default is used for TEST3
    //     "--defaultSigner.key", RELAYER_KEYS[2],
    //     "--relayChains=test1,test2",
    // ];

    if !log_all {
        println!("Logs in {}", log_dir.display());
    }
    println!("Relayer DB in {}", relayer_db.display());

    let build_cmd = {
        let build_log = make_static(build_log.to_str().unwrap().into());
        move |cmd, path, env| build_cmd(cmd, build_log, log_all, path, env, true)
    };

    // this task takes a long time in the CI so run it in parallel
    let build_rust = {
        spawn(move || {
            println!("Building rust...");
            build_cmd(
                &[
                    "cargo",
                    "build",
                    "--bin",
                    "relayer",
                ],
                None,
                None,
            );
        })
    };

    println!("Installing typescript dependencies...");
    if is_ci_env {
        // don't need to install typescript deps locally
        build_cmd(&["yarn", "install"], Some("../"), None);
        build_cmd(&["yarn", "build:e2e"], Some("../"), None);
    }

    let mut state = State::default();
    state.build_log = build_log;
    state.log_all = log_all;

    println!("Launching anvil for l1 (forked from eth Mainnet)...");
    let mut args = ["--fork-url", "https://eth.llamarpc.com", "--chain-id", "31337", "--port", "8546"];
    let mut l1_node = Command::new("anvil");
    l1_node.args(&args);
    if log_all {
        l1_node.stdout(Stdio::null());
    } else {
        // Assuming append_to(anvil_log) returns a valid Stdio instance
        l1_node.stdout(append_to(&anvil_log));
    }
    let l1_node = l1_node.spawn().expect("Failed to start l1 node");
    state.l1_node = Some(l1_node);

    println!("Launching anvil for l2 (forked from optimsim Mainnet)...");
    args[1] = "https://mainnet.optimism.io";
    args[5] = "8547";
    let mut l2_node = Command::new("anvil");
    l2_node.args(&args);
    if log_all {
        l2_node.stdout(Stdio::null());
    } else {
        // Assuming append_to(anvil_log) returns a valid Stdio instance
        l2_node.stdout(append_to(&anvil_log));
    }
    let l2_node = l2_node.spawn().expect("Failed to start l1 node");
    state.l2_node = Some(l2_node);

    sleep(Duration::from_secs(10));

    let deploy_env = hashmap! {"ALLOW_LEGACY_MULTISIG_ISM" => "true"};

    println!("Deploying hook contracts...");
    build_cmd(
        &["yarn", "deploy-hook"],
        Some("../typescript/infra"),
        Some(&deploy_env),
    );

    println!("Rebuilding sdk...");
    build_cmd(&["yarn", "build"], Some("../typescript/sdk"), None);

    build_rust.join().unwrap();

    println!("relayer_Env: {:?}", relayer_env.clone());

    let (relayer, relayer_stdout, relayer_stderr) = run_agent(
        "relayer",
        &relayer_env.into_iter().chain(common_env.clone()).collect(),
        &relayer_args,
        "RLY",
        log_all,
        &log_dir,
    );
    println!("relayer: {:?}", relayer);
    println!("relayer_Args: {:?}", relayer_args);
    
    state.watchers.push(relayer_stdout);
    state.watchers.push(relayer_stderr);
    state.relayer = Some(relayer);

    println!("Setup complete! Agents running in background...");
    println!("Ctrl+C to end execution...");


    let loop_start = Instant::now();
    let mut messages_left = hook_messages as u32;
    // give things a chance to fully start.
    sleep(Duration::from_secs(5));
    while RUNNING.fetch_and(true, Ordering::Relaxed) {

        println!("Simulating native hook dispatch...");
        build_cmd(
            &["yarn", "orchestrate-hook"],
            Some("../typescript/infra"),
            Some(&deploy_env),
        );

        if ci_mode {
            // for CI we have to look for the end condition.
            if termination_invariants_met(messages_left).unwrap_or(false) {
                // end condition reached successfully
                println!("Agent metrics look healthy");
                break;
            } else if (Instant::now() - loop_start).as_secs() > ci_mode_timeout {
                // we ran out of time
                eprintln!("CI timeout reached before queues emptied");
                return ExitCode::from(1);
            }
            messages_left -= 1;
        }
        sleep(Duration::from_secs(5));
    }

    ExitCode::from(0)
}

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent.
fn termination_invariants_met(num_expected_messages: u32) -> Result<bool> {
    if num_expected_messages == 0 {
        println!("<E2E> No messages expected, terminating");
        return Ok(true);
    } else {
        println!(
            "<E2E> Waiting for {} messages to be processed",
            num_expected_messages
        );
        return Ok(false);
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
    assert_success: bool,
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
    if let Some(env) = env {
        c.envs(env);
    }
    let status = c.status().expect("Failed to run command");
    if assert_success {
        assert!(
            status.success(),
            "Command returned non-zero exit code: {}",
            cmd.join(" ")
        );
    }
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
    let mut child = command
        .spawn()
        .unwrap_or_else(|_| panic!("Failed to start {}", name));
    let stdout_path = concat_path(log_dir, format!("{}.stdout.log", log_prefix));
    let child_stdout = child.stdout.take().unwrap();
    let stdout = spawn(move || {
        if log_all {
            prefix_log(child_stdout, log_prefix)
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
            prefix_log(child_stderr, log_prefix)
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

