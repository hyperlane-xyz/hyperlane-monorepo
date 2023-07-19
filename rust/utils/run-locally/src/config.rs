use std::collections::HashMap;
use std::env;
use std::ffi::OsStr;
use std::fmt::{Debug, Display, Formatter};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use crate::utils::LogFilter;

pub struct Config {
    pub is_ci_env: bool,
    pub ci_mode: bool,
    pub ci_mode_timeout: u64,
    pub kathy_messages: u64,
    pub log_all: bool,
}

impl Config {
    pub fn load() -> Self {
        let ci_mode = env::var("E2E_CI_MODE")
            .map(|k| k.parse::<bool>().unwrap())
            .unwrap_or_default();
        Self {
            is_ci_env: env::var("CI").as_deref() == Ok("true"),
            ci_mode,
            ci_mode_timeout: env::var("E2E_CI_TIMEOUT_SEC")
                .map(|k| k.parse::<u64>().unwrap())
                .unwrap_or(60 * 10),
            kathy_messages: {
                let r = env::var("E2E_KATHY_MESSAGES")
                    .ok()
                    .map(|r| r.parse::<u64>().unwrap());
                r.unwrap_or(16)
            },
            log_all: env::var("E2E_LOG_ALL")
                .map(|k| k.parse::<bool>().unwrap())
                .unwrap_or(ci_mode),
        }
    }
}

#[derive(Default, Clone)]
pub struct ProgramArgs {
    bin_path: Option<Arc<PathBuf>>,
    args: Vec<Arc<String>>,
    env: HashMap<Arc<String>, Arc<String>>,
    working_dir: Option<Arc<PathBuf>>,
    log_filter: Option<LogFilter>,
}

impl Debug for ProgramArgs {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProgramArgs")
            .field("bin_path", &self.bin_path)
            .field("args", &self.args)
            .field("env", &self.env)
            .field("working_dir", &self.working_dir)
            .field("log_filter", &self.log_filter.is_some())
            .finish()
    }
}

impl Display for ProgramArgs {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        if f.alternate() {
            let wd = self
                .working_dir
                .as_ref()
                .map(|wd| wd.display())
                .unwrap_or_else(|| Path::new("./").display());
            write!(f, "({wd})$ ")?;

            for (k, v) in &self.env {
                write!(f, "{k}={v} ")?;
            }

            if let Some(bp) = &self.bin_path {
                write!(f, "{}", bp.display())?;
            } else {
                write!(f, "???")?;
            }

            for a in &self.args {
                write!(f, " {a}")?;
            }

            Ok(())
        } else {
            write!(f, "{}", self.get_bin_name())
        }
    }
}

impl ProgramArgs {
    pub fn new(bin: impl AsRef<OsStr>) -> Self {
        Self::default().bin(bin)
    }

    pub fn bin(mut self, bin: impl AsRef<OsStr>) -> Self {
        self.bin_path = Some(
            which::which(bin)
                .expect("bin not found or is not executable")
                .into(),
        );
        self
    }

    pub fn raw_arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into().into());
        self
    }

    pub fn cmd(self, cmd: impl Into<String>) -> Self {
        let cmd = cmd.into();
        debug_assert!(!cmd.starts_with('-'), "arg should not start with -");
        self.raw_arg(cmd)
    }

    pub fn flag(self, arg: impl AsRef<str>) -> Self {
        debug_assert!(
            !arg.as_ref().starts_with('-'),
            "arg should not start with -"
        );
        self.raw_arg(format!("--{}", arg.as_ref()))
    }

    /// Assumes an arg in the format of `--$ARG1 $ARG2`, arg1 and arg2 should exclude quoting, equal sign, and the leading hyphens.
    pub fn arg(self, arg1: impl AsRef<str>, arg2: impl Into<String>) -> Self {
        self.flag(arg1).cmd(arg2)
    }

    /// add an env that will be prefixed with the default hyperlane env prefix
    pub fn hyp_env(self, key: impl AsRef<str>, value: impl Into<String>) -> Self {
        const PREFIX: &str = "HYP_BASE_";
        let key = key.as_ref();
        debug_assert!(
            !key.starts_with(PREFIX),
            "env key should not start with prefix that is being added"
        );
        self.env(format!("{PREFIX}{key}"), value)
    }

    /// add a system env that makes no prefix assumptions
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into().into(), value.into().into());
        self
    }

    pub fn working_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.working_dir = Some(path.into().into());
        self
    }

    /// Filter logs being printed to stdout/stderr
    pub fn filter_logs(mut self, filter: LogFilter) -> Self {
        self.log_filter = Some(filter);
        self
    }

    pub fn create_command(&self) -> Command {
        let mut cmd = Command::new(
            self.bin_path
                .as_deref()
                .expect("A bin path must be specified"),
        );
        if let Some(wd) = &self.working_dir {
            cmd.current_dir(wd.as_path());
        }
        for (k, v) in self.env.iter() {
            cmd.env(k.as_str(), v.as_str());
        }
        cmd.args(self.args.iter().map(AsRef::as_ref));
        cmd
    }

    pub fn get_filter(&self) -> Option<LogFilter> {
        self.log_filter
    }

    pub fn get_bin_name(&self) -> &str {
        self.bin_path
            .as_deref()
            .expect("A bin path must be specified")
            .file_name()
            .expect("bin path must have a file name")
            .to_str()
            .unwrap()
    }
}

// macro_rules! program {
//     // entry
//     ($($rest:tt)+) => {
//         program!(@a ProgramArgs::default(), $($rest)*)
//     };
//
//     // env
//     (@a $prog:expr, $key:literal=$val:literal $($rest:tt)+) => {
//         program!(@a $prog.env($key, $val), $($rest)*)
//     };
//
//     // bin
//     (@a $prog:expr, $bin:literal $($rest:tt)*) => {
//         program!(@b $prog.bin($bin), $($rest:tt)*)
//     };
//
//     (@b $prog:expr, $arg:literal $($rest:tt)*) => {
//         program!(@b $prog.raw_arg($bin), $($rest:tt)*)
//     };
//
//     (@b $prog:expr,) => { $prog };
// }
//
// pub(crate) use program;
