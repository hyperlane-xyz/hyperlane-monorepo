//! Run this from the abacus-monorepo/rust directory using `cargo run -r -p run-locally`.

use maplit::hashmap;
use nix::libc::pid_t;
use nix::sys::signal;
use nix::sys::signal::Signal;
use nix::unistd::Pid;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Lines, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{sleep, spawn, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, fs, thread};
use tempfile::tempdir;

static RUNNING: AtomicBool = AtomicBool::new(true);

fn main() {
    ctrlc::set_handler(|| {
        println!("Terminating...");
        RUNNING.store(false, Ordering::Relaxed);
    })
    .unwrap();

    let date_str = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();
    let log_dir = concat_path(env::temp_dir(), format!("logs/abacus-agents/{date_str}"));
    fs::create_dir_all(&log_dir).expect("Failed to make log dir");
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

    println!("Logs in {}", log_dir.display());
    println!("Signed checkpoints in {}", checkpoints_dir.path().display());
    println!("Relayer DB in {}", relayer_db.display());
    println!("Validator DB in {}", validator_db.display());

    println!("Building typescript...");
    build_cmd(
        &["yarn", "install"],
        &build_log,
        Some("../typescript/infra"),
    );
    build_cmd(&["yarn", "build"], &build_log, Some("../typescript"));

    println!("Building relayer...");
    build_cmd(&["cargo", "build", "--bin", "relayer"], &build_log, None);

    println!("Building validator...");
    build_cmd(&["cargo", "build", "--bin", "validator"], &build_log, None);

    println!("Launching hardhat...");
    let mut node = Command::new("yarn")
        .args(&["hardhat", "node"])
        .current_dir("../typescript/infra")
        .stdout(append_to(&hardhat_log))
        .spawn()
        .expect("Failed to start node");
    sleep(Duration::from_secs(1));

    println!("Deploying abacus contracts...");
    let status = Command::new("yarn")
        .arg("abacus")
        .current_dir("../typescript/infra")
        .stdout(Stdio::null())
        .status()
        .expect("Failed to deploy contracts")
        .success();
    assert!(status, "Failed to deploy contracts");

    // println!("Spawning relayer...");
    // let relayer = Command::new("target/debug/relayer")
    //     .stdout(append_to(&relayer_stdout_log))
    //     .stderr(append_to(&relayer_stderr_log))
    //     .spawn()
    //     .expect("Failed to start relayer");
    //
    // println!("Spawning validator...");
    // let relayer = Command::new("target/debug/validator")
    //     .stdout(append_to(&validator_stdout_log))
    //     .stderr(append_to(&validator_stderr_log))
    //     .spawn()
    //     .expect("Failed to start validator");

    println!("Setup complete! Agents running in background...");
    println!("Ctrl+C to end execution...");

    println!("Spawning Kathy to send Abacus message traffic...");
    let mut kathy = Command::new("yarn")
        .args(&["kathy"])
        .current_dir("../typescript/infra")
        .stdout(Stdio::piped())
        .spawn()
        .expect("Failed tp start kathy");
    let kathy_stdout = kathy.stdout.take().unwrap();
    let kathy_tail = spawn(move || kathy_tail(kathy_stdout, kathy_log));

    // curl http://127.0.0.1:9092/metrics 2>/dev/null | egrep -o "^abacus_processor_retry_queue{.+} [0-9]+$" | egrep -o "[0-9]+$"

    // Emit any ERROR logs found in an agent's stdout or the presence of anything at all in stderr.

    // (tail -f "${RELAYER_STDOUT_LOG?}" | grep ERROR) &
    // (tail -f "${VALIDATOR_STDOUT_LOG?}" | grep ERROR) &
    // (tail -f "${RELAYER_STDERR_LOG?}") &
    // (tail -f "${VALIDATOR_STDERR_LOG?}") &

    sleep(Duration::from_secs(60));
    println!("End of sleep");
    send_sigterm(&mut node);
    send_sigterm(&mut kathy);

    RUNNING.store(false, Ordering::Relaxed);
    kathy_tail.join().unwrap();
}

fn kathy_tail(kathy_stdout: impl Read, kathy_log: impl AsRef<Path>) {
    let mut writer = BufWriter::new(append_to(kathy_log));
    let mut reader = BufReader::new(kathy_stdout).lines();
    loop {
        if let Some(line) = reader.next().map(|v| v.unwrap()) {
            if line.contains("send") {
                println!("{line}");
            }
            writeln!(writer, "{line}").unwrap();
        } else {
            sleep(Duration::from_millis(100));
        }

        if !RUNNING.fetch_and(true, Ordering::Relaxed) {
            break;
        }
    }
}

fn send_sigterm(child: &mut Child) {
    let pid = Pid::from_raw(child.id() as pid_t);
    if signal::kill(pid, Signal::SIGTERM).is_err() {
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

fn build_cmd(cmd: &[&str], log: impl AsRef<Path>, wd: Option<&str>) {
    assert!(!cmd.is_empty(), "Must specify a command!");
    let mut c = Command::new(cmd[0]);
    c.args(&cmd[1..]).stdout(append_to(log));
    if let Some(wd) = wd {
        c.current_dir(wd);
    }
    let status = c.status().expect("Failed to run command");
    assert!(status.success(), "Command returned non-zero exit code");
}
