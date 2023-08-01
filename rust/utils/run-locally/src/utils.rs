use eyre::{eyre, Result};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::thread::JoinHandle;

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
        $fn_vis fn $fn_name($($arg_name$(: $arg_type)*),*) -> impl $crate::utils::TaskHandle<Output=as_task!(@strip_result $($ret_type)?)> {
            $crate::utils::SimpleTaskHandle(::std::thread::spawn(move || {Ok($body)}))
        }
    };

    (@strip_result $(::)?$(eyre::)?Result<$ret_type:ty>) => { $ret_type };
    (@strip_result $ret_type:ty) => {$ret_type};
    (@strip_result) => {()};
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
);
pub type LogFilter = fn(&str) -> bool;

#[must_use]
pub trait TaskHandle: Send {
    type Output;

    fn join(self) -> Result<Self::Output>;
    fn join_box(self: Box<Self>) -> Result<Self::Output>;
}

/// Wrapper around a join handle to simplify use.
#[must_use]
pub struct SimpleTaskHandle<T>(pub JoinHandle<Result<T>>);
impl<T> TaskHandle for SimpleTaskHandle<T> {
    type Output = T;

    fn join(self) -> Result<T> {
        self.0
            .join()
            .map_err(|e| eyre!("Task thread panicked: {e:?}"))
            .and_then(|r| r)
    }

    fn join_box(self: Box<Self>) -> Result<T> {
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

    fn join(self) -> Result<U> {
        self.0.join().map(self.1)
    }

    fn join_box(self: Box<Self>) -> Result<U> {
        self.join()
    }
}

/// Attempt to stop a child process.
pub fn stop_child(child: &mut Child) {
    if let Err(e) = child.try_wait() {
        log!("{}", e);
    } else {
        // already stopped
        return;
    }
    if let Err(e) = child.kill() {
        log!("{}", e);
    }
}
