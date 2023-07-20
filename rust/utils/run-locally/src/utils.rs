use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{sleep, spawn, JoinHandle};
use std::time::Duration;

use nix::libc::pid_t;
use nix::sys::signal;
use nix::sys::signal::Signal;
use nix::unistd::Pid;

use crate::config::{Config, ProgramArgs};
use crate::logging::log;
use crate::{RUN_LOG_WATCHERS, SHUTDOWN};

pub fn make_static(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

/// Merge two paths.
pub fn concat_path(p1: impl AsRef<Path>, p2: impl AsRef<Path>) -> PathBuf {
    let mut p = p1.as_ref().to_path_buf();
    p.push(p2);
    p
}

pub type AgentHandles = (Child, TaskHandle<()>, TaskHandle<()>);
pub type LogFilter = fn(&str) -> bool;

pub fn run_agent(args: ProgramArgs, log_prefix: &'static str, config: &Config) -> AgentHandles {
    let mut command = args.create_command();
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    log!("Spawning {}...", &args);
    let mut child = command
        .spawn()
        .unwrap_or_else(|e| panic!("Failed to start {:?} with error: {e}", &args));
    let stdout_path = concat_path(&config.log_dir, format!("{log_prefix}.stdout.log"));
    let child_stdout = child.stdout.take().unwrap();
    let filter = args.get_filter();
    let log_all = config.log_all;
    let stdout = spawn(move || {
        if log_all {
            prefix_log(child_stdout, log_prefix, &RUN_LOG_WATCHERS, filter)
        } else {
            inspect_and_write_to_file(
                child_stdout,
                stdout_path,
                &["ERROR", "message successfully processed"],
            )
        }
    });
    let stderr_path = concat_path(&config.log_dir, format!("{log_prefix}.stderr.log"));
    let child_stderr = child.stderr.take().unwrap();
    let stderr = spawn(move || {
        if log_all {
            prefix_log(child_stderr, log_prefix, &RUN_LOG_WATCHERS, filter)
        } else {
            inspect_and_write_to_file(child_stderr, stderr_path, &[])
        }
    });
    (child, TaskHandle(stdout), TaskHandle(stderr))
}

/// Wrapper around a join handle to simplify use.
#[must_use]
pub struct TaskHandle<T>(pub JoinHandle<T>);
impl<T> TaskHandle<T> {
    pub fn join(self) -> T {
        self.0.join().expect("Task thread panicked!")
    }
}

pub fn build_cmd(
    args: ProgramArgs,
    log: impl AsRef<Path>,
    log_all: bool,
    assert_success: bool,
) -> TaskHandle<()> {
    let log = log.as_ref().to_owned();
    let handle = spawn(move || build_cmd_task(args, log, log_all, assert_success));
    TaskHandle(handle)
}

/// Attempt to kindly signal a child to stop running, and kill it if that fails.
pub fn stop_child(child: &mut Child) {
    if child.try_wait().unwrap().is_some() {
        // already stopped
        return;
    }
    let pid = Pid::from_raw(child.id() as pid_t);
    if signal::kill(pid, Signal::SIGTERM).is_err() {
        log!("Failed to send sigterm, killing");
        if let Err(e) = child.kill() {
            log!("{}", e);
        }
    };
}

/// Open a file in append mode, or create it if it does not exist.
fn append_to(p: impl AsRef<Path>) -> File {
    File::options()
        .create(true)
        .append(true)
        .open(p)
        .expect("Failed to open file")
}

/// Read from a process output and add a string to the front before writing it
/// to stdout.
fn prefix_log(
    output: impl Read,
    prefix: &str,
    run_log_watcher: &AtomicBool,
    filter: Option<LogFilter>,
) {
    let mut reader = BufReader::new(output).lines();
    loop {
        if let Some(line) = reader.next() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    // end of stream, probably
                    log!("Error reading from output for {}: {}", prefix, e);
                    break;
                }
            };
            if let Some(filter) = filter.as_ref() {
                if !(filter)(&line) {
                    continue;
                }
            }
            println!("<{prefix}> {line}");
        } else if run_log_watcher.load(Ordering::Relaxed) {
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
                    log!("Error reading from output: {}", e);
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
        } else if RUN_LOG_WATCHERS.load(Ordering::Relaxed) {
            sleep(Duration::from_millis(10))
        } else {
            break;
        }
    }
}

fn build_cmd_task(args: ProgramArgs, log: PathBuf, log_all: bool, assert_success: bool) {
    let mut command = args.create_command();
    if log_all {
        command.stdout(Stdio::piped());
    } else {
        command.stdout(append_to(log));
    }
    command.stderr(Stdio::piped());

    log!("{:#}", &args);
    let mut child = command
        .spawn()
        .unwrap_or_else(|e| panic!("Failed to start command `{}` with Error: {e}", &args));
    let filter = args.get_filter();
    let running = Arc::new(AtomicBool::new(true));
    let stdout = if log_all {
        let stdout = child.stdout.take().unwrap();
        let name = args.get_bin_name();
        let running = running.clone();
        Some(spawn(move || prefix_log(stdout, &name, &running, filter)))
    } else {
        None
    };
    let stderr = {
        let stderr = child.stderr.take().unwrap();
        let name = args.get_bin_name();
        let running = running.clone();
        spawn(move || prefix_log(stderr, &name, &running, filter))
    };

    let status = loop {
        sleep(Duration::from_millis(500));

        if let Some(exit_status) = child.try_wait().expect("Failed to run command") {
            break exit_status;
        } else if SHUTDOWN.load(Ordering::Relaxed) {
            log!("Forcing termination of command `{}`", &args);
            stop_child(&mut child);
            break child.wait().expect("Failed to run command");
        }
    };

    running.store(false, Ordering::Relaxed);
    if let Some(stdout) = stdout {
        stdout.join().unwrap();
    }
    stderr.join().unwrap();
    assert!(
        !assert_success || !RUN_LOG_WATCHERS.load(Ordering::Relaxed) || status.success(),
        "Command returned non-zero exit code: {:?}",
        &args
    );
}
