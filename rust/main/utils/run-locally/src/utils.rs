use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use nix::libc::pid_t;
use nix::sys::signal;
use nix::sys::signal::Signal;
use nix::unistd::Pid;

use crate::logging::log;

/// Make a function run as a task by writing `#[apply(as_task)]`. This will spawn a new thread
/// and then return the result through a TaskHandle.
macro_rules! as_task {
    (
        $(#[$fn_meta:meta])*
        $fn_vis:vis fn $fn_name:ident(
            $($arg_name:ident$(: $arg_type:ty)?),*$(,)?
        ) $(-> $ret_type:ty)? $body:block
    ) => {
        $(#[$fn_meta])*
        $fn_vis fn $fn_name($($arg_name$(: $arg_type)*),*) -> impl $crate::utils::TaskHandle<Output=as_task!(@handle $($ret_type)?)> {
            $crate::utils::SimpleTaskHandle(::std::thread::spawn(move || $body))
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
    // name
    String,
    // child process
    Child,
    // stdout
    Box<dyn TaskHandle<Output = ()>>,
    // stderr
    Box<dyn TaskHandle<Output = ()>>,
    // data to drop once program exits
    Box<dyn ArbitraryData>,
    // file with stdout logs
    Option<Arc<Mutex<File>>>,
);
pub type LogFilter = fn(&str) -> bool;

#[must_use]
pub trait TaskHandle: Send {
    type Output;

    fn join(self) -> Self::Output;
    fn join_box(self: Box<Self>) -> Self::Output;
}

/// Wrapper around a join handle to simplify use.
#[must_use]
pub struct SimpleTaskHandle<T>(pub JoinHandle<T>);
impl<T> TaskHandle for SimpleTaskHandle<T> {
    type Output = T;

    fn join(self) -> Self::Output {
        self.0.join().expect("Task thread panicked!")
    }

    fn join_box(self: Box<Self>) -> T {
        self.join()
    }
}

#[must_use]
pub struct MappingTaskHandle<T, H: TaskHandle<Output = T>, U, F: FnOnce(T) -> U>(pub H, pub F);
impl<T, H, U, F> TaskHandle for MappingTaskHandle<T, H, U, F>
where
    H: TaskHandle<Output = T>,
    F: Send + FnOnce(T) -> U,
{
    type Output = U;

    fn join(self) -> Self::Output {
        (self.1)(self.0.join())
    }

    fn join_box(self: Box<Self>) -> U {
        self.join()
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
        log!("Failed to send sigterm, killing");
        if let Err(e) = child.kill() {
            log!("{}", e);
        }
    };
}

/// Given a Vec<Vec<&str>>,
/// for each Vec<&str>, count how many lines in the file
/// matches all the &str in that Vec.
/// Store this count in a hashmap where the key is the vector
/// Vec<&str>
/// and return this hashmap.
pub fn get_matching_lines<'a>(
    file: &File,
    search_strings: Vec<Vec<&'a str>>,
) -> HashMap<Vec<&'a str>, u32> {
    let reader = io::BufReader::new(file);
    let mut matches = HashMap::new();

    let mut lines = reader.lines();
    while let Some(Ok(line)) = lines.next() {
        search_strings.iter().for_each(|search_string_vec| {
            if search_string_vec
                .iter()
                .map(|search_string| line.contains(search_string))
                .all(|x| x)
            {
                let count = matches.entry(search_string_vec.clone()).or_insert(0);
                *count += 1;
            }
        });
    }
    matches
}

/// Returns absolute path to rust workspace
/// `/<...>/hyperlane-monorepo/rust/main`.
/// This allows us to have a more reliable way of generating
/// relative paths such path to sealevel directory
pub fn get_workspace_path() -> PathBuf {
    let output = Command::new(env!("CARGO"))
        .arg("locate-project")
        .arg("--workspace")
        .arg("--message-format=plain")
        .output()
        .expect("Failed to get workspace path")
        .stdout;
    let path_str = String::from_utf8(output).expect("Failed to parse workspace path");
    let mut workspace_path = PathBuf::from(path_str);
    // pop Cargo.toml from path
    workspace_path.pop();
    workspace_path
}

/// Returns absolute path to sealevel directory
/// `/<...>/hyperlane-monorepo/rust/sealevel`
#[cfg(feature = "sealevel")]
pub fn get_sealevel_path(workspace_path: &Path) -> PathBuf {
    concat_path(
        workspace_path
            .parent()
            .expect("workspace path has no parent"),
        "sealevel",
    )
}

/// Returns absolute path to typescript infra directory
/// `/<...>/hyperlane-monorepo/typescript/infra`
pub fn get_ts_infra_path() -> PathBuf {
    let output = Command::new("git")
        .arg("rev-parse")
        .arg("--show-toplevel")
        .output()
        .expect("Failed to get git workspace path")
        .stdout;
    let path_str = String::from_utf8(output).expect("Failed to parse workspace path");
    let git_workspace_path = PathBuf::from(path_str.trim());
    concat_path(git_workspace_path, "typescript/infra")
}
