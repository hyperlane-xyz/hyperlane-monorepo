use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fmt::{Debug, Display, Formatter},
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread::{sleep, spawn},
    time::Duration,
};

use eyre::Context;
use macro_rules_attribute::apply;

use crate::{
    logging::log,
    utils::{
        as_task, stop_child, AgentHandles, ArbitraryData, LogFilter, MappingTaskHandle,
        SimpleTaskHandle, TaskHandle,
    },
    RUN_LOG_WATCHERS, SHUTDOWN,
};

#[derive(Default, Clone)]
#[must_use]
pub struct Program {
    bin: Option<Arc<String>>,
    args: Vec<Arc<String>>,
    env: BTreeMap<Arc<String>, Arc<String>>,
    working_dir: Option<Arc<PathBuf>>,
    log_filter: Option<LogFilter>,
    arbitrary_data: Vec<Arc<dyn ArbitraryData>>,
}

impl Debug for Program {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Program")
            .field("bin", &self.bin)
            .field("args", &self.args)
            .field("env", &self.env)
            .field("working_dir", &self.working_dir)
            .field("log_filter", &self.log_filter.is_some())
            .finish()
    }
}

impl Display for Program {
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

impl Program {
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

    /// Assumes an arg in the format of `--$ARG1 $ARG2 $ARG3`, args should exclude quoting, equal sign, and the leading hyphens.
    #[allow(dead_code)]
    pub fn arg3(
        self,
        arg1: impl AsRef<str>,
        arg2: impl Into<String>,
        arg3: impl Into<String>,
    ) -> Self {
        self.flag(arg1).cmd(arg2).cmd(arg3)
    }

    /// add an env that will be prefixed with the default hyperlane env prefix
    pub fn hyp_env(self, key: impl AsRef<str>, value: impl Into<String>) -> Self {
        const PREFIX: &str = "HYP_";
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

    /// Remember some arbitrary data until either this program args goes out of scope or until the
    /// agent/child process exits. This is useful for preventing something from dropping.
    #[allow(dead_code)]
    pub fn remember(mut self, data: impl ArbitraryData) -> Self {
        self.arbitrary_data.push(Arc::new(data));
        self
    }

    pub fn create_command(&self) -> Command {
        let mut cmd = Command::new(
            self.get_bin_path()
                .expect("bin path must be specified")
                .unwrap(),
        );
        if let Some(wd) = &self.working_dir {
            if !wd.exists() {
                panic!("Working directory does not exist: {:?}", wd.as_path());
            }
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
    pub fn get_bin_path(&self) -> Option<eyre::Result<PathBuf>> {
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

    pub fn get_memory(&self) -> Box<dyn ArbitraryData> {
        Box::new(self.arbitrary_data.clone())
    }

    #[allow(dead_code)]
    pub fn run(self) -> impl TaskHandle<Output = ()> {
        MappingTaskHandle(self.run_full(true, false), |_| ())
    }

    #[allow(dead_code)]
    pub fn run_ignore_code(self) -> impl TaskHandle<Output = ()> {
        MappingTaskHandle(self.run_full(false, false), |_| ())
    }

    #[allow(dead_code)]
    pub fn run_with_output(self) -> impl TaskHandle<Output = Vec<String>> {
        MappingTaskHandle(self.run_full(false, true), |o| {
            o.expect("Command did not return output")
        })
    }

    pub fn spawn(self, log_prefix: &'static str, logs_dir: Option<&Path>) -> AgentHandles {
        let mut command = self.create_command();
        let log_file = logs_dir.map(|logs_dir| {
            let log_file_name = format!("{}-output.log", log_prefix);
            let log_file_path = logs_dir.join(log_file_name);
            let log_file = OpenOptions::new()
                .append(true)
                .create(true)
                .open(log_file_path)
                .expect("Failed to create a log file");
            Arc::new(Mutex::new(log_file))
        });
        command.stdout(Stdio::piped()).stderr(Stdio::piped());

        log!("Spawning {}...", &self);
        let mut child = command
            .spawn()
            .unwrap_or_else(|e| panic!("Failed to start {:?} with error: {e}", &self));
        let child_stdout = child.stdout.take().unwrap();
        let filter = self.get_filter();
        let cloned_log_file = log_file.clone();
        let stdout = spawn(move || {
            prefix_log(
                child_stdout,
                log_prefix,
                &RUN_LOG_WATCHERS,
                filter,
                cloned_log_file,
                None,
            )
        });
        let child_stderr = child.stderr.take().unwrap();
        let stderr = spawn(move || {
            prefix_log(
                child_stderr,
                log_prefix,
                &RUN_LOG_WATCHERS,
                filter,
                None,
                None,
            )
        });
        (
            log_prefix.to_owned(),
            child,
            Box::new(SimpleTaskHandle(stdout)),
            Box::new(SimpleTaskHandle(stderr)),
            self.get_memory(),
            log_file.clone(),
        )
    }

    #[apply(as_task)]
    fn run_full(self, assert_success: bool, capture_output: bool) -> Option<Vec<String>> {
        let mut command = self.create_command();
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        log!("{:#}", &self);
        let mut child = command
            .spawn()
            .unwrap_or_else(|e| panic!("Failed to start command `{}` with Error: {e}", &self));
        let filter = self.get_filter();
        let running = Arc::new(AtomicBool::new(true));
        let (stdout_ch_tx, stdout_ch_rx) = capture_output.then(mpsc::channel).unzip();
        let stdout = {
            let stdout = child.stdout.take().unwrap();
            let name = self.get_bin_name();
            let running = running.clone();
            spawn(move || prefix_log(stdout, &name, &running, filter, None, stdout_ch_tx))
        };
        let stderr = {
            let stderr = child.stderr.take().unwrap();
            let name = self.get_bin_name();
            let running = running.clone();
            spawn(move || prefix_log(stderr, &name, &running, filter, None, None))
        };

        let status = loop {
            sleep(Duration::from_millis(500));

            if let Some(exit_status) = child.try_wait().expect("Failed to run command") {
                break exit_status;
            } else if SHUTDOWN.load(Ordering::Relaxed) {
                log!("Forcing termination of command `{}`", &self);
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
            &self
        );

        stdout_ch_rx.map(|rx| rx.into_iter().collect())
    }
}

/// Read from a process output and add a string to the front before writing it to stdout.
fn prefix_log(
    output: impl Read,
    prefix: &str,
    run_log_watcher: &AtomicBool,
    filter: Option<LogFilter>,
    file: Option<Arc<Mutex<File>>>,
    channel: Option<Sender<String>>,
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
            if let Some(file) = &file {
                let mut writer = file.lock().expect("Failed to acquire lock for log file");
                writeln!(writer, "{}", line).unwrap_or(());
            }
            if let Some(channel) = &channel {
                // ignore send errors
                channel.send(line).unwrap_or(());
            }
        } else if run_log_watcher.load(Ordering::Relaxed) {
            sleep(Duration::from_millis(10));
        } else {
            break;
        }
    }
}
