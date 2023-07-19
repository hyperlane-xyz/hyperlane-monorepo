// use std::ops::{Deref, DerefMut};
//
// pub struct OnDrop<T, F: FnMut(&mut T)> {
//     value: T,
//     on_drop: F,
// }
//
// impl<T, F: FnMut(&mut T)> Drop for OnDrop<T, F> {
//     fn drop(&mut self) {
//         (self.on_drop)(&mut self.value);
//     }
// }
//
// impl<T, F: FnMut(&mut T)> Deref for OnDrop<T, F> {
//     type Target = T;
//
//     fn deref(&self) -> &Self::Target {
//         &self.value
//     }
// }
//
// impl<T, F: FnMut(&mut T)> DerefMut for OnDrop<T, F> {
//     fn deref_mut(&mut self) -> &mut Self::Target {
//         &mut self.value
//     }
// }
//
// pub fn on_drop<T, F: FnMut(&mut T)>(value: T, on_drop: F) -> OnDrop<T, F> {
//     OnDrop { value, on_drop }
// }

use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{sleep, spawn, JoinHandle};
use std::time::Duration;

use nix::libc::pid_t;
use nix::sys::signal;
use nix::sys::signal::Signal;
use nix::unistd::Pid;

use crate::config::ProgramArgs;
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

pub fn run_agent(
    bin_path: impl AsRef<Path>,
    args: &ProgramArgs,
    log_prefix: &'static str,
    log_all: bool,
    log_dir: &PathBuf,
) -> (Child, JoinHandle<()>, JoinHandle<()>) {
    let bin_display = bin_path.as_ref().display();
    let mut command = Command::new(bin_path.as_ref());
    command.envs(args.list_envs()).args(args.list_args());
    if let Some(wd) = &args.list_working_dir() {
        command.current_dir(wd);
    }
    log!("Spawning {}...", bin_display);

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .unwrap_or_else(|e| panic!("Failed to start {bin_display} with error: {e}"));
    let stdout_path = concat_path(log_dir, format!("{log_prefix}.stdout.log"));
    let child_stdout = child.stdout.take().unwrap();
    let stdout = spawn(move || {
        if log_all {
            prefix_log(child_stdout, log_prefix, &RUN_LOG_WATCHERS)
        } else {
            inspect_and_write_to_file(
                child_stdout,
                stdout_path,
                &["ERROR", "message successfully processed"],
            )
        }
    });
    let stderr_path = concat_path(log_dir, format!("{log_prefix}.stderr.log"));
    let child_stderr = child.stderr.take().unwrap();
    let stderr = spawn(move || {
        if log_all {
            prefix_log(child_stderr, log_prefix, &RUN_LOG_WATCHERS)
        } else {
            inspect_and_write_to_file(child_stderr, stderr_path, &[])
        }
    });
    (child, stdout, stderr)
}

/// Wrapper around a join handle to simplify use.
#[must_use]
pub struct AssertJoinHandle<T>(JoinHandle<T>);
impl<T> AssertJoinHandle<T> {
    pub fn join(self) -> T {
        self.0
            .join()
            .expect("Thread running build command panicked!")
    }
}

// TODO: take ProgramArgs instead and create better logging on what command is being run by impl Debug/Display
//  and make bin_path part of ProgramArgs
pub fn build_cmd(
    cmd: &[&str],
    log: impl AsRef<Path>,
    log_all: bool,
    wd: Option<&dyn AsRef<Path>>,
    env: Option<&HashMap<&str, &str>>,
    assert_success: bool,
) -> AssertJoinHandle<()> {
    let log = log.as_ref().to_owned();
    let wd = wd.map(|p| p.as_ref().to_owned());
    let cmd = cmd.iter().map(|&s| s.to_owned()).collect();
    let env = env.map(|e| {
        e.iter()
            .map(|(&k, &v)| (k.to_owned(), v.to_owned()))
            .collect()
    });
    let handle = spawn(move || build_cmd_task(cmd, log, log_all, wd, env, assert_success));
    AssertJoinHandle(handle)
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
pub fn append_to(p: impl AsRef<Path>) -> File {
    File::options()
        .create(true)
        .append(true)
        .open(p)
        .expect("Failed to open file")
}

/// Read from a process output and add a string to the front before writing it
/// to stdout.
fn prefix_log(output: impl Read, name: impl AsRef<str>, run_log_watcher: &AtomicBool) {
    let prefix = name.as_ref();
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

fn build_cmd_task(
    cmd: Vec<String>,
    log: PathBuf,
    log_all: bool,
    wd: Option<PathBuf>,
    env: Option<HashMap<String, String>>,
    assert_success: bool,
) {
    assert!(!cmd.is_empty(), "Must specify a command!");
    let mut command = Command::new(&cmd[0]);
    command.args(&cmd[1..]);
    if log_all {
        command.stdout(Stdio::piped());
    } else {
        command.stdout(append_to(log));
    }
    command.stderr(Stdio::piped());
    if let Some(wd) = &wd {
        command.current_dir(wd);
    }
    if let Some(env) = env {
        command.envs(env);
    }

    log!(
        "({})$ {}",
        wd.as_ref()
            .map(|wd| wd.display())
            .unwrap_or(env::current_dir().unwrap().display()),
        cmd.join(" ")
    );

    let mut child = command.spawn().unwrap_or_else(|e| {
        panic!(
            "Failed to start command `{}` with Error: {e}",
            cmd.join(" ")
        )
    });
    let running = Arc::new(AtomicBool::new(true));
    let stdout = if log_all {
        let stdout = child.stdout.take().unwrap();
        let name = cmd[0].to_owned();
        let running = running.clone();
        Some(spawn(move || prefix_log(stdout, name, &running)))
    } else {
        None
    };
    let stderr = {
        let stderr = child.stderr.take().unwrap();
        let name = cmd[0].to_owned();
        let running = running.clone();
        spawn(move || prefix_log(stderr, name, &running))
    };

    let status = loop {
        if let Some(exit_status) = child.try_wait().expect("Failed to run command") {
            break exit_status;
        } else if SHUTDOWN.load(Ordering::Relaxed) {
            log!("Forcing termination of command `{}`", cmd.join(" "));
            stop_child(&mut child);
            break child.wait().expect("Failed to run command");
        } else {
            sleep(Duration::from_millis(100));
        }
    };

    running.store(false, Ordering::Relaxed);
    if let Some(stdout) = stdout {
        stdout.join().unwrap();
    }
    stderr.join().unwrap();
    assert!(
        !assert_success || !RUN_LOG_WATCHERS.load(Ordering::Relaxed) || status.success(),
        "Command returned non-zero exit code: {}",
        cmd.join(" ")
    );
}
