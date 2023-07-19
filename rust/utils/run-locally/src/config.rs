use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::rc::Rc;

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
    args: Vec<(Rc<String>, Option<Rc<String>>)>,
    env: HashMap<Rc<String>, Rc<String>>,
    working_dir: Option<Rc<PathBuf>>,
}

impl ProgramArgs {
    pub fn raw_arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push((arg.into().into(), None));
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
    pub fn arg(mut self, arg1: impl Into<String>, arg2: impl Into<String>) -> Self {
        let (arg1, arg2) = (arg1.into(), arg2.into());
        debug_assert!(!arg1.starts_with('-'), "arg1 should not start with -");
        debug_assert!(
            !arg2.starts_with('=') && !arg1.ends_with('='),
            "arg2 should not start with = or arg1 should not end with ="
        );
        self.args.push((arg1.into(), Some(arg2.into())));
        self
    }

    /// add an env that will be prefixed with the default hyperlane env prefix
    pub fn env(self, key: impl AsRef<str>, value: impl Into<String>) -> Self {
        const PREFIX: &str = "HYP_BASE_";
        let key = key.as_ref();
        debug_assert!(
            !key.starts_with(PREFIX),
            "env key should not start with prefix that is being added"
        );
        self.sys_env(format!("{PREFIX}{key}"), value)
    }

    /// add a system env that makes no prefix assumptions
    pub fn sys_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into().into(), value.into().into());
        self
    }

    pub fn working_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.working_dir = Some(path.into().into());
        self
    }

    pub fn list_envs(&self) -> impl Iterator<Item = (&str, &str)> {
        self.env.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    pub fn list_args(&self) -> impl Iterator<Item = String> + '_ {
        self.args
            .iter()
            .flat_map(|(k, v)| {
                if let Some(v) = v {
                    [
                        Some(format!("--{}", k.as_str())),
                        Some(v.as_str().to_owned()),
                    ]
                } else {
                    [Some(k.as_str().to_owned()), None]
                }
            })
            .flatten()
    }

    pub fn list_working_dir(&self) -> Option<&Path> {
        self.working_dir.as_ref().map(|r| r.as_path())
    }
}
