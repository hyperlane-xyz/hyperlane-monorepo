use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{sleep, spawn, JoinHandle};
use std::time::Duration;

use macro_rules_attribute::apply;
use nix::libc::pid_t;
use nix::sys::signal;
use nix::sys::signal::Signal;
use nix::unistd::Pid;

use crate::config::{ProgramArgs};
use crate::logging::log;
use crate::{RUN_LOG_WATCHERS, SHUTDOWN};

/// Make a function run as a task by writing `#[apply(as_task)]`. This will spawn a new thread
/// and then return the result through a TaskHandle.
macro_rules! as_task {
    (
        $(#[$fn_meta:meta])*
        $fn_vis:vis fn $fn_name:ident($($arg_name:ident: $arg_type:ty),*$(,)?) $(-> $ret_type:ty)? $body:block
    ) => {
        $(#[$fn_meta])*
        $fn_vis fn $fn_name($($arg_name: $arg_type),*) -> $crate::utils::TaskHandle<as_task!(@handle $($ret_type)?)> {
            $crate::utils::TaskHandle(::std::thread::spawn(move || $body))
        }
    };
    (@handle $ret_type:ty) => {$ret_type};
    (@handle) => {()};
}

pub(crate) use as_task;

pub fn make_static(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

/// Merge two paths.
pub fn concat_path(p1: impl AsRef<Path>, p2: impl AsRef<Path>) -> PathBuf {
    let mut p = p1.as_ref().to_path_buf();
    p.push(p2);
    p
}

pub trait ArbitraryData: Send + Sync + 'static {}
impl<T: Send + Sync + 'static> ArbitraryData for T {}

pub type AgentHandles = (
    Child,
    TaskHandle<()>,
    TaskHandle<()>,
    Box<dyn ArbitraryData>,
);
pub type LogFilter = fn(&str) -> bool;

pub fn run_agent(args: ProgramArgs, log_prefix: &'static str) -> AgentHandles {
    let mut command = args.create_command();
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    log!("Spawning {}...", &args);
    let mut child = command
        .spawn()
        .unwrap_or_else(|e| panic!("Failed to start {:?} with error: {e}", &args));
    let child_stdout = child.stdout.take().unwrap();
    let filter = args.get_filter();
    let stdout = spawn(move || prefix_log(child_stdout, log_prefix, &RUN_LOG_WATCHERS, filter));
    let child_stderr = child.stderr.take().unwrap();
    let stderr = spawn(move || prefix_log(child_stderr, log_prefix, &RUN_LOG_WATCHERS, filter));
    (
        child,
        TaskHandle(stdout),
        TaskHandle(stderr),
        args.get_memory(),
    )
}

/// Wrapper around a join handle to simplify use.
#[must_use]
pub struct TaskHandle<T>(pub JoinHandle<T>);
impl<T> TaskHandle<T> {
    pub fn join(self) -> T {
        self.0.join().expect("Task thread panicked!")
    }
}

#[apply(as_task)]
pub fn build_cmd(args: ProgramArgs, assert_success: bool) {
    let mut command = args.create_command();
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    log!("{:#}", &args);
    let mut child = command
        .spawn()
        .unwrap_or_else(|e| panic!("Failed to start command `{}` with Error: {e}", &args));
    let filter = args.get_filter();
    let running = Arc::new(AtomicBool::new(true));
    let stdout = {
        let stdout = child.stdout.take().unwrap();
        let name = args.get_bin_name();
        let running = running.clone();
        spawn(move || prefix_log(stdout, &name, &running, filter))
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
    stdout.join().unwrap();
    stderr.join().unwrap();
    assert!(
        !assert_success || !RUN_LOG_WATCHERS.load(Ordering::Relaxed) || status.success(),
        "Command returned non-zero exit code: {:?}",
        &args
    );
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
