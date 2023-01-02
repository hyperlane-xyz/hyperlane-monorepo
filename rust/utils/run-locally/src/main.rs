//! Run this from the hyperlane-monorepo/rust directory using `cargo run -r -p run-locally`.
//!
//! Environment arguments:
//! - `E2E_CI_MODE`: true/false, enables CI mode which will automatically wait for kathy to finish
//! running and for the queues to empty. Defaults to false.
//! - `E2E_CI_TIMEOUT_SEC`: How long (in seconds) to allow the main loop to run the test for. This
//! does not include the initial setup time. If this timeout is reached before the end conditions
//! are met, the test is a failure. Defaults to 10 min.
//! - `E2E_KATHY_ROUNDS`: Number of rounds to run kathy for. Defaults to 4 if CI mode is enabled.
//! - `E2E_LOG_ALL`: Log all output instead of writing to log files. Defaults to true if CI mode,
//! else false.

use std::{
    env,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Write},
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

static RUNNING: AtomicBool = AtomicBool::new(true);

/// Struct to hold stuff we want to cleanup whenever we exit. Just using for cleanup purposes at
/// this time.
#[derive(Default)]
struct State {
    kathy: Option<Child>,
    node: Option<Child>,
    relayer: Option<Child>,
    validator: Option<Child>,

    watchers: Vec<JoinHandle<()>>,
}

impl Drop for State {
    fn drop(&mut self) {
        println!("Signaling children to stop...");
        if let Some(mut c) = self.kathy.take() {
            stop_child(&mut c);
            if !c.wait().unwrap().success() {
                eprintln!("Kathy exited with error code")
            };
        }
        if let Some(mut c) = self.relayer.take() {
            stop_child(&mut c);
            if !c.wait().unwrap().success() {
                eprintln!("Relayer exited with error code")
            };
        }
        if let Some(mut c) = self.validator.take() {
            stop_child(&mut c);
            if !c.wait().unwrap().success() {
                eprintln!("Validator exited with error code")
            };
        }
        if let Some(mut c) = self.node.take() {
            stop_child(&mut c);
            if !c.wait().unwrap().success() {
                eprintln!("Node exited with error code")
            };
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

    let ci_mode = env::var("E2E_CI_MODE")
        .map(|k| k.parse::<bool>().unwrap())
        .unwrap_or_default();

    let ci_mode_timeout = env::var("E2E_CI_TIMEOUT_SEC")
        .map(|k| k.parse::<u64>().unwrap())
        .unwrap_or(60 * 10);

    let kathy_rounds = {
        let r = env::var("E2E_KATHY_ROUNDS")
            .ok()
            .map(|r| r.parse::<u64>().unwrap());
        if ci_mode && r.is_none() {
            Some(4)
        } else {
            r
        }
    };

    // NOTE: This is defined within the Kathy script and could potentially drift.
    // TODO: Plumb via environment variable or something.
    let kathy_messages_per_round = 10;

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
    let relayer_stdout_log = concat_path(&log_dir, "relayer.stdout.log");
    let relayer_stderr_log = concat_path(&log_dir, "relayer.stderr.log");
    let validator_stdout_log = concat_path(&log_dir, "validator.stdout.log");
    let validator_stderr_log = concat_path(&log_dir, "validator.stderr.log");
    let kathy_log = concat_path(&log_dir, "kathy.stdout.log");

    let checkpoints_dir = tempdir().unwrap();
    let rocks_db_dir = tempdir().unwrap();
    let relayer_db = concat_path(&rocks_db_dir, "relayer");
    let validator_db = concat_path(&rocks_db_dir, "validator");

    let common_env = hashmap! {
        "RUST_BACKTRACE" => "full"
    };

    let relayer_env = hashmap! {
        "HYP_BASE_CHAINS_TEST1_CONNECTION_URLS" => "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        "HYP_BASE_CHAINS_TEST1_CONNECTION_TYPE" => "httpQuorum",
        "HYP_BASE_CHAINS_TEST2_CONNECTION_URLS" => "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        "HYP_BASE_CHAINS_TEST2_CONNECTION_TYPE" => "httpQuorum",
        "HYP_BASE_CHAINS_TEST3_CONNECTION_URL" => "http://127.0.0.1:8545",
        "HYP_BASE_CHAINS_TEST3_CONNECTION_TYPE" => "http",
        "BASE_CONFIG" => "test_config.json",
        "RUN_ENV" => "test",
        "HYP_BASE_METRICS" => "9092",
        "HYP_BASE_TRACING_FMT" => "pretty",
        "HYP_BASE_TRACING_LEVEL" => "info",
        "HYP_BASE_DB" => relayer_db.to_str().unwrap(),
        "HYP_BASE_SIGNERS_TEST1_KEY" => "8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61",
        "HYP_BASE_SIGNERS_TEST1_TYPE" => "hexKey",
        "HYP_BASE_SIGNERS_TEST2_KEY" => "f214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897",
        "HYP_BASE_SIGNERS_TEST2_TYPE" => "hexKey",
        "HYP_BASE_SIGNERS_TEST3_KEY" => "701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82",
        "HYP_BASE_SIGNERS_TEST3_TYPE" => "hexKey",
        "HYP_RELAYER_GASPAYMENTENFORCEMENTPOLICY_TYPE" => "none",
        "HYP_RELAYER_ORIGINCHAINNAME" => "test1",
        "HYP_RELAYER_WHITELIST" => r#"[{"sourceAddress": "*", "destinationDomain": ["13372", "13373"], "destinationAddress": "*"}]"#,
        "HYP_RELAYER_MULTISIGCHECKPOINTSYNCER_CHECKPOINTSYNCERS_0x70997970c51812dc3a010c7d01b50e0d17dc79c8_TYPE" => "localStorage",
        "HYP_RELAYER_MULTISIGCHECKPOINTSYNCER_CHECKPOINTSYNCERS_0x70997970c51812dc3a010c7d01b50e0d17dc79c8_PATH" => checkpoints_dir.path().to_str().unwrap(),
    };

    let validator_env = hashmap! {
        "HYP_BASE_CHAINS_TEST1_CONNECTION_URLS" => "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        "HYP_BASE_CHAINS_TEST1_CONNECTION_TYPE" => "httpQuorum",
        "HYP_BASE_CHAINS_TEST2_CONNECTION_URLS" => "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545",
        "HYP_BASE_CHAINS_TEST2_CONNECTION_TYPE" => "httpQuorum",
        "HYP_BASE_CHAINS_TEST3_CONNECTION_URLS" => "http://127.0.0.1:8545",
        "HYP_BASE_CHAINS_TEST3_CONNECTION_TYPE" => "http",
        "BASE_CONFIG" => "test_config.json",
        "RUN_ENV" => "test",
        "HYP_BASE_METRICS" => "9091",
        "HYP_BASE_TRACING_FMT" => "pretty",
        "HYP_BASE_TRACING_LEVEL" => "info",
        "HYP_BASE_DB" => validator_db.to_str().unwrap(),
        "HYP_VALIDATOR_ORIGINCHAINNAME" => "test1",
        "HYP_VALIDATOR_VALIDATOR_KEY" => "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        "HYP_VALIDATOR_VALIDATOR_TYPE" => "hexKey",
        "HYP_VALIDATOR_REORGPERIOD" => "0",
        "HYP_VALIDATOR_INTERVAL" => "5",
        "HYP_VALIDATOR_CHECKPOINTSYNCER_TYPE" => "localStorage",
        "HYP_VALIDATOR_CHECKPOINTSYNCER_PATH" => checkpoints_dir.path().to_str().unwrap(),
    };

    if !log_all {
        println!("Logs in {}", log_dir.display());
    }
    println!("Signed checkpoints in {}", checkpoints_dir.path().display());
    println!("Relayer DB in {}", relayer_db.display());
    println!("Validator DB in {}", validator_db.display());

    println!("Building typescript...");
    build_cmd(&["yarn", "install"], &build_log, log_all, Some("../"));
    build_cmd(&["yarn", "clean"], &build_log, log_all, Some("../"));
    build_cmd(&["yarn", "build"], &build_log, log_all, Some("../"));

    println!("Building relayer...");
    build_cmd(
        &["cargo", "build", "--bin", "relayer"],
        &build_log,
        log_all,
        None,
    );

    println!("Building validator...");
    build_cmd(
        &["cargo", "build", "--bin", "validator"],
        &build_log,
        log_all,
        None,
    );

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
        node.stdout(append_to(&hardhat_log));
    }
    let node = node.spawn().expect("Failed to start node");
    // if log_all {
    //     let output = node.stdout.take().unwrap();
    //     state
    //         .watchers
    //         .push(spawn(move || prefix_log(output, "ETH")))
    // }
    state.node = Some(node);

    sleep(Duration::from_secs(10));

    println!("Deploying hyperlane contracts...");
    let status = Command::new("yarn")
        .arg("hyperlane")
        .current_dir("../typescript/infra")
        .stdout(Stdio::null())
        .status()
        .expect("Failed to deploy contracts")
        .success();
    assert!(status, "Failed to deploy contracts");

    // Follow-up 'yarn hardhat node' invocation with 'yarn prettier' to fixup
    // formatting on any autogenerated json config files to avoid any diff creation.
    Command::new("yarn")
        .args(["prettier"])
        .current_dir("../")
        .status()
        .expect("Failed to run prettier from top level dir");

    println!("Spawning relayer...");
    let mut relayer = Command::new("target/debug/relayer")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(&common_env)
        .envs(&relayer_env)
        .spawn()
        .expect("Failed to start relayer");
    let relayer_stdout = relayer.stdout.take().unwrap();
    state.watchers.push(spawn(move || {
        if log_all {
            prefix_log(relayer_stdout, "RLY")
        } else {
            inspect_and_write_to_file(
                relayer_stdout,
                relayer_stdout_log,
                &["ERROR", "message successfully processed"],
            )
        }
    }));
    let relayer_stderr = relayer.stderr.take().unwrap();
    state.watchers.push(spawn(move || {
        if log_all {
            prefix_log(relayer_stderr, "RLY")
        } else {
            inspect_and_write_to_file(relayer_stderr, relayer_stderr_log, &[])
        }
    }));
    state.relayer = Some(relayer);

    println!("Spawning validator...");
    let mut validator = Command::new("target/debug/validator")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(&common_env)
        .envs(&validator_env)
        .spawn()
        .expect("Failed to start validator");
    let validator_stdout = validator.stdout.take().unwrap();
    state.watchers.push(spawn(move || {
        if log_all {
            prefix_log(validator_stdout, "VAL")
        } else {
            inspect_and_write_to_file(validator_stdout, validator_stdout_log, &["ERROR"])
        }
    }));
    let validator_stderr = validator.stderr.take().unwrap();
    state.watchers.push(spawn(move || {
        if log_all {
            prefix_log(validator_stderr, "VAL")
        } else {
            inspect_and_write_to_file(validator_stderr, validator_stderr_log, &[])
        }
    }));
    state.validator = Some(validator);

    println!("Setup complete! Agents running in background...");
    println!("Ctrl+C to end execution...");

    println!("Spawning Kathy to send Hyperlane message traffic...");
    let mut kathy = Command::new("yarn");
    kathy.arg("kathy");
    if let Some(r) = kathy_rounds {
        kathy.args(["--rounds", &r.to_string()]);
    }
    let mut kathy = kathy
        .current_dir("../typescript/infra")
        .stdout(Stdio::piped())
        .spawn()
        .expect("Failed to start kathy");
    let kathy_stdout = kathy.stdout.take().unwrap();
    state.watchers.push(spawn(move || {
        if log_all {
            prefix_log(kathy_stdout, "KTY")
        } else {
            inspect_and_write_to_file(kathy_stdout, kathy_log, &["send"])
        }
    }));
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
            if kathy_done && retry_queues_empty() {
                assert_termination_invariants(
                    kathy_rounds.unwrap() as u32 * kathy_messages_per_round,
                );
                // end condition reached successfully
                println!("Kathy completed successfully and the retry queues are empty");
                break;
            } else if (Instant::now() - loop_start).as_secs() > ci_mode_timeout {
                // we ran out of time
                eprintln!("CI timeout reached before queues emptied and or kathy finished.");
                return ExitCode::from(1);
            }
        } else if kathy_done {
            // when not in CI mode, run until kathy finishes, which should only happen if a number
            // of rounds is specified.
            break;
        }
        sleep(Duration::from_secs(1));
    }

    ExitCode::from(0)
}

/// Use the metrics to check if the relayer queues are empty.
fn retry_queues_empty() -> bool {
    let lengths: Vec<_> = ureq::get("http://127.0.0.1:9092/metrics")
        .call()
        .unwrap()
        .into_string()
        .unwrap()
        .lines()
        .filter(|l| l.starts_with("hyperlane_submitter_queue_length"))
        .map(|l| l.rsplit_once(' ').unwrap().1.parse::<u32>().unwrap())
        .collect();
    assert!(!lengths.is_empty(), "Could not find queue length metric");
    lengths.into_iter().all(|n| n == 0)
}

/// Read from a process output and add a string to the front before writing it to stdout.
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

/// Assert invariants for state upon successful test termination.
fn assert_termination_invariants(num_expected_messages_processed: u32) {
    // The value of `hyperlane_last_known_message_nonce{phase=message_processed}` should refer
    // to the maximum nonce value we ever successfully delivered. Since deliveries can happen
    // out-of-index-order, we separately track a counter of the number of successfully delivered
    // messages. At the end of this test, they should both hold the same value.
    let msg_processed_max_index: Vec<_> = ureq::get("http://127.0.0.1:9092/metrics")
        .call()
        .unwrap()
        .into_string()
        .unwrap()
        .lines()
        .filter(|l| l.contains(r#"phase="message_processed""#))
        .filter(|l| l.starts_with("hyperlane_last_known_message_nonce"))
        .map(|l| l.rsplit_once(' ').unwrap().1.parse::<u32>().unwrap())
        .collect();
    assert!(
        !msg_processed_max_index.is_empty(),
        "Could not find message_processed phase metric"
    );
    // The max index is one less than the number delivered messages, since it is an index into the
    // mailbox merkle tree leafs. Since the metric is parameterized by mailbox, and the test
    // non-deterministically selects the destination mailbox between test2 and test3 for the highest
    // message, we take the max over the metric vector.
    assert_eq!(
        msg_processed_max_index.into_iter().max().unwrap(),
        num_expected_messages_processed - 1
    );

    // Also ensure the counter is as expected (total number of messages), summed across all
    // mailboxes.
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
    assert_eq!(
        num_expected_messages_processed,
        msg_processed_count.into_iter().sum::<u32>()
    );

    let gas_payment_events_count = ureq::get("http://127.0.0.1:9092/metrics")
        .call()
        .unwrap()
        .into_string()
        .unwrap()
        .lines()
        .filter(|l| l.starts_with("hyperlane_contract_sync_stored_events"))
        .filter(|l| l.contains(r#"data_type="gas_payments""#))
        .map(|l| l.rsplit_once(' ').unwrap().1.parse::<u32>().unwrap())
        .next()
        .unwrap();
    assert!(
        gas_payment_events_count >= num_expected_messages_processed,
        "Synced gas payment event count is less than the number of messages"
    );
}

/// Basically `tail -f file | grep <FILTER>` but also has to write to the file (writes to file all
/// lines, not just what passes the filter).
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

fn build_cmd(cmd: &[&str], log: impl AsRef<Path>, log_all: bool, wd: Option<&str>) {
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
