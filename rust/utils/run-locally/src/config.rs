use std::collections::HashMap;
use std::env;
use std::ffi::OsStr;
use std::fmt::{Debug, Display, Formatter};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use eyre::{Context, Result};

use crate::utils::{concat_path, LogFilter};

pub struct Config {
    pub is_ci_env: bool,
    pub ci_mode: bool,
    pub ci_mode_timeout: u64,
    pub kathy_messages: u64,
    pub log_all: bool,
    pub log_dir: PathBuf,
}

impl Config {
    pub fn load() -> Self {
        let ci_mode = env::var("E2E_CI_MODE")
            .map(|k| k.parse::<bool>().unwrap())
            .unwrap_or_default();
        let date_str = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        let log_dir = concat_path(env::temp_dir(), format!("logs/hyperlane-agents/{date_str}"));
        Self {
            ci_mode,
            log_dir,
            is_ci_env: env::var("CI").as_deref() == Ok("true"),
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
    bin: Option<Arc<String>>,
    args: Vec<Arc<String>>,
    env: HashMap<Arc<String>, Arc<String>>,
    working_dir: Option<Arc<PathBuf>>,
    log_filter: Option<LogFilter>,
}

impl Debug for ProgramArgs {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProgramArgs")
            .field("bin", &self.bin)
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

            if let Some(path_result) = self.get_bin_path() {
                if let Ok(bp) = path_result {
                    write!(f, "{}", bp.display())?;
                } else {
                    write!(f, "{}", self.bin.as_ref().unwrap())?;
                }
            } else {
                write!(f, "???")?;
            }

            for a in &self.args {
                write!(f, " {a}")?;
            }

            Ok(())
        } else {
            write!(
                f,
                "{}",
                self.bin.as_deref().map(String::as_str).unwrap_or("???")
            )
        }
    }
}

impl ProgramArgs {
    pub fn new(bin: impl AsRef<OsStr>) -> Self {
        Self::default().bin(bin)
    }

    pub fn bin(mut self, bin: impl AsRef<OsStr>) -> Self {
        self.bin = Some(
            bin.as_ref()
                .to_str()
                .expect("Invalid string encoding for binary name")
                .to_owned()
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

    /// Filter logs being printed to stdout/stderr. If the LogFilter returns true,
    /// then it will keep that log line, if it returns false it will discard it.
    /// This is ignored when logging to files.
    pub fn filter_logs(mut self, filter: LogFilter) -> Self {
        self.log_filter = Some(filter);
        self
    }

    pub fn create_command(&self) -> Command {
        let mut cmd = Command::new(
            self.get_bin_path()
                .expect("bin path must be specified")
                .unwrap(),
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

    /// Try to get the path to the binary
    pub fn get_bin_path(&self) -> Option<Result<PathBuf>> {
        self.bin.as_ref().map(|raw_bin_name| {
            which::which(raw_bin_name.as_ref())
                .with_context(|| format!("Cannot find binary: {raw_bin_name}"))
        })
    }

    /// Get just the name component of the binary
    pub fn get_bin_name(&self) -> String {
        Path::new(
            self.bin
                .as_ref()
                .expect("bin path must be specified")
                .as_str(),
        )
        .file_name()
        .expect("bin must have a file name")
        .to_str()
        .unwrap()
        .to_owned()
    }
}
