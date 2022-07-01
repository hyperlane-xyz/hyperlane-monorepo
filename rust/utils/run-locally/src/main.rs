//! Run this from the abacus-monorepo/rust directory using `cargo run -r -p run-locally`.
//!
//! Enviornment arguments:
//! - `E2E_CI_MODE`: true/false, enables CI mode which will automatically wait for kathy to finish
//! running and for the queues to empty.
//! - `E2E_CI_TIMEOUT_SEC`: How long (in seconds) to allow the main loop to run the test for. This
//! does not include the initial setup time. If this timeout is reached before the end conditions
//! are met, the test is a failure. Defaults to 5 min.
//! - `E2E_KATHY_ROUNDS`: Number of rounds to run kathy for. Defaults to 4 if CI mode is enabled.
//! - `E2E_LOG_ALL`: Log all output instead of writing to log files. Defaults to true if CI mode,
//! else false.

use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{sleep, spawn, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs};

use maplit::hashmap;
use nix::libc::pid_t;
use nix::sys::signal;
use nix::sys::signal::Signal;
use nix::unistd::Pid;
use tempfile::tempdir;

static RUNNING: AtomicBool = AtomicBool::new(true);

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
            send_sigterm(&mut c);
            if !c.wait().unwrap().success() {
                eprintln!("Kathy exited with error code")
            };
        }
        if let Some(mut c) = self.relayer.take() {
            send_sigterm(&mut c);
            if !c.wait().unwrap().success() {
                eprintln!("Relayer exited with error code")
            };
        }
        if let Some(mut c) = self.validator.take() {
            send_sigterm(&mut c);
            if !c.wait().unwrap().success() {
                eprintln!("Validator exited with error code")
            };
        }
        if let Some(mut c) = self.node.take() {
            send_sigterm(&mut c);
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
        .unwrap_or(60 * 5);

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

    let log_all = env::var("E2E_LOG_ALL")
        .map(|k| k.parse::<bool>().unwrap())
        .unwrap_or(ci_mode);

    let date_str = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();
    let log_dir = concat_path(env::temp_dir(), format!("logs/abacus-agents/{date_str}"));
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
        "ABC_BASE_OUTBOX_CONNECTION_URL" => "http://localhost:8545",
        "ABC_BASE_INBOXES_TEST2_CONNECTION_URL" => "http://localhost:8545",
        "ABC_BASE_INBOXES_TEST3_CONNECTION_URL" => "http://localhost:8545",
        "BASE_CONFIG" => "test1_config.json",
        "RUN_ENV" => "test",
        "ABC_BASE_METRICS" => "9092",
        "ABC_BASE_TRACING_FMT" => "pretty",
        "ABC_BASE_TRACING_LEVEL" => "info",
        "ABC_BASE_DB" => relayer_db.to_str().unwrap(),
        "ABC_BASE_SIGNERS_TEST1_KEY" => "8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61",
        "ABC_BASE_SIGNERS_TEST1_TYPE" => "hexKey",
        "ABC_BASE_SIGNERS_TEST2_KEY" => "f214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897",
        "ABC_BASE_SIGNERS_TEST2_TYPE" => "hexKey",
        "ABC_BASE_SIGNERS_TEST3_KEY" => "701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82",
        "ABC_BASE_SIGNERS_TEST3_TYPE" => "hexKey",
        "ABC_RELAYER_WHITELIST" => r#"[{"sourceAddress": "*", "destinationDomain": ["13372", "13373"], "destinationAddress": "*"}]"#,
        "ABC_RELAYER_SIGNEDCHECKPOINTPOLLINGINTERVAL" => "5",
        "ABC_RELAYER_MAXPROCESSINGRETRIES" => "5",
        "ABC_RELAYER_MULTISIGCHECKPOINTSYNCER_THRESHOLD" => "1",
        "ABC_RELAYER_MULTISIGCHECKPOINTSYNCER_CHECKPOINTSYNCERS_0x70997970c51812dc3a010c7d01b50e0d17dc79c8_TYPE" => "localStorage",
        "ABC_RELAYER_MULTISIGCHECKPOINTSYNCER_CHECKPOINTSYNCERS_0x70997970c51812dc3a010c7d01b50e0d17dc79c8_PATH" => checkpoints_dir.path().to_str().unwrap(),
    };

    let validator_env = hashmap! {
        "ABC_BASE_OUTBOX_CONNECTION_URL" => "http://127.0.0.1:8545",
        "ABC_BASE_INBOXES_TEST2_CONNECTION_URL" => "http://127.0.0.1:8545",
        "ABC_BASE_INBOXES_TEST3_CONNECTION_URL" => "http://127.0.0.1:8545",
        "BASE_CONFIG" => "test1_config.json",
        "RUN_ENV" => "test",
        "ABC_BASE_METRICS" => "9091",
        "ABC_BASE_TRACING_FMT" => "pretty",
        "ABC_BASE_TRACING_LEVEL" => "info",
        "ABC_BASE_DB" => validator_db.to_str().unwrap(),
        "ABC_VALIDATOR_VALIDATOR_KEY" => "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        "ABC_VALIDATOR_VALIDATOR_TYPE" => "hexKey",
        "ABC_VALIDATOR_REORGPERIOD" => "0",
        "ABC_VALIDATOR_INTERVAL" => "5",
        "ABC_VALIDATOR_CHECKPOINTSYNCER_THRESHOLD" => "1",
        "ABC_VALIDATOR_CHECKPOINTSYNCER_TYPE" => "localStorage",
        "ABC_VALIDATOR_CHECKPOINTSYNCER_PATH" => checkpoints_dir.path().to_str().unwrap(),
    };

    if !log_all {
        println!("Logs in {}", log_dir.display());
    }
    println!("Signed checkpoints in {}", checkpoints_dir.path().display());
    println!("Relayer DB in {}", relayer_db.display());
    println!("Validator DB in {}", validator_db.display());

    println!("Building typescript...");
    build_cmd(
        &["yarn", "install"],
        &build_log,
        log_all,
        Some("../typescript/infra"),
    );
    build_cmd(
        &["yarn", "build"],
        &build_log,
        log_all,
        Some("../typescript"),
    );

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
    node.args(&["hardhat", "node"])
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

    sleep(Duration::from_secs(5));

    println!("Deploying abacus contracts...");
    let status = Command::new("yarn")
        .arg("abacus")
        .current_dir("../typescript/infra")
        .stdout(Stdio::null())
        .status()
        .expect("Failed to deploy contracts")
        .success();
    assert!(status, "Failed to deploy contracts");

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
            inspect_and_write_to_file(relayer_stdout, relayer_stdout_log, Some("ERROR"))
        }
    }));
    let relayer_stderr = relayer.stderr.take().unwrap();
    state.watchers.push(spawn(move || {
        if log_all {
            prefix_log(relayer_stderr, "RLY")
        } else {
            inspect_and_write_to_file(relayer_stderr, relayer_stderr_log, None)
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
            inspect_and_write_to_file(validator_stdout, validator_stdout_log, Some("ERROR"))
        }
    }));
    let validator_stderr = validator.stderr.take().unwrap();
    state.watchers.push(spawn(move || {
        if log_all {
            prefix_log(validator_stderr, "VAL")
        } else {
            inspect_and_write_to_file(validator_stderr, validator_stderr_log, None)
        }
    }));
    state.validator = Some(validator);

    println!("Setup complete! Agents running in background...");
    println!("Ctrl+C to end execution...");

    println!("Spawning Kathy to send Abacus message traffic...");
    let mut kathy = Command::new("yarn");
    kathy.arg("kathy");
    if let Some(r) = kathy_rounds {
        kathy.args(&["--rounds", &r.to_string()]);
    }
    let mut kathy = kathy
        .current_dir("../typescript/infra")
        .stdout(Stdio::piped())
        .spawn()
        .expect("Failed tp start kathy");
    let kathy_stdout = kathy.stdout.take().unwrap();
    state.watchers.push(spawn(move || {
        if log_all {
            prefix_log(kathy_stdout, "KTY")
        } else {
            inspect_and_write_to_file(kathy_stdout, kathy_log, Some("send"))
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

fn retry_queues_empty() -> bool {
    ureq::get("http://127.0.0.1:9092")
        .call()
        .unwrap()
        .into_string()
        .unwrap()
        .lines()
        .filter(|l| l.starts_with("abacus_processor_retry_queue"))
        .map(|l| l.rsplit_once(' ').unwrap().1.parse::<u32>().unwrap())
        .all(|n| n == 0)
}

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

/// Basically `tail -f file | grep <FILTER>` but also has to write to the file (writes to file all
/// lines, not just what passes the filter).
fn inspect_and_write_to_file(
    output: impl Read,
    log: impl AsRef<Path>,
    filter: Option<&'static str>,
) {
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

            if let Some(f) = filter {
                if line.contains(f) {
                    println!("{line}")
                }
            } else {
                println!("{line}")
            }
            writeln!(writer, "{line}").unwrap();
        } else if RUNNING.fetch_and(true, Ordering::Relaxed) {
            sleep(Duration::from_millis(10))
        } else {
            break;
        }
    }
}

fn send_sigterm(child: &mut Child) {
    let pid = Pid::from_raw(child.id() as pid_t);
    if signal::kill(pid, Signal::SIGTERM).is_err() {
        eprintln!("Failed to send sigterm, killing");
        if let Err(e) = child.kill() {
            eprintln!("{}", e);
        }
    };
}

fn concat_path(p1: impl AsRef<Path>, p2: impl AsRef<Path>) -> PathBuf {
    let mut p = p1.as_ref().to_path_buf();
    p.push(p2);
    p
}

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
    assert!(status.success(), "Command returned non-zero exit code");
}
