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
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;
use std::thread::{sleep, spawn, JoinHandle};
use std::time::Duration;

use nix::libc::pid_t;
use nix::sys::signal;
use nix::sys::signal::Signal;
use nix::unistd::Pid;

use crate::config::ProgramArgs;
use crate::RUNNING;

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
    println!("Spawning {bin_display}...");

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .unwrap_or_else(|_| panic!("Failed to start {bin_display}"));
    let stdout_path = concat_path(log_dir, format!("{log_prefix}.stdout.log"));
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
    let stderr_path = concat_path(log_dir, format!("{log_prefix}.stderr.log"));
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

pub fn build_cmd(
    cmd: &[&str],
    log: impl AsRef<Path>,
    log_all: bool,
    wd: Option<&dyn AsRef<Path>>,
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

/// Attempt to kindly signal a child to stop running, and kill it if that fails.
pub fn stop_child(child: &mut Child) {
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
