use {
    crate::utils::{AgentArgs, Args, ChainSettings, Launcher},
    cargo_metadata::MetadataCommand,
    grug::btree_map,
    std::{
        collections::{BTreeMap, BTreeSet},
        fs::{self, File},
        io::{BufRead, BufReader},
        path::PathBuf,
        process::{Child, Command, Stdio},
        sync::{Arc, Mutex},
        thread,
    },
    tempfile::TempDir,
};

#[derive(Default)]
pub struct Agent<A> {
    agent: A,
    chains_args: BTreeMap<String, String>,
    chains: BTreeSet<String>,
    db: Option<Db2>,
    metrics_port: Option<MetricsPort2>,
    piped: Option<Piped>,
    log_format: Option<LogFormat>,
    log_level: Option<LogLevel>,
}

impl<A> Agent<A>
where
    A: Default,
{
    pub fn new(agent: A) -> Self {
        Self {
            agent,
            ..Default::default()
        }
    }

    pub fn with_chain<C>(mut self, setting: ChainSettings<C>) -> Self
    where
        C: Args,
    {
        self.chains.insert(setting.chain_name.clone());
        self.chains_args.extend(setting.args());
        self
    }

    pub fn with_db(mut self, db: Location2) -> Self {
        self.db = Some(Db2(db));
        self
    }

    pub fn with_metrics_port(mut self, metrics_port: u16) -> Self {
        self.metrics_port = Some(MetricsPort2(metrics_port));
        self
    }

    pub fn with_piped(mut self, piped: Piped) -> Self {
        self.piped = Some(piped);
        self
    }

    pub fn with_log_format(mut self, log_format: LogFormat) -> Self {
        self.log_format = Some(log_format);
        self
    }

    pub fn with_log_level(mut self, log_level: LogLevel) -> Self {
        self.log_level = Some(log_level);
        self
    }
}

impl<A> Agent<A>
where
    A: Launcher + AgentArgs,
{
    pub fn launch(self) -> Child {
        let piped = self.piped.clone();

        let args = self
            .args()
            .into_iter()
            .map(|(key, value)| {
                let v = vec![format!("--{key}"), value];
                println!("{:?}", v);
                v
            })
            .flatten()
            .collect::<Vec<_>>();

        let mut cmd = Command::new(format!("./target/debug/{}", A::PATH));
        cmd.args(args).current_dir(workspace());

        if let Some(piped) = &piped {
            match piped {
                Piped::File(_) => {
                    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
                }
            }
        }

        let mut child = cmd.spawn().unwrap();

        if let Some(piped) = &piped {
            match piped {
                Piped::File(path_buf) => {
                    let log = Arc::new(Mutex::new(File::create(path_buf).unwrap()));
                    let stdout = child.stdout.take().unwrap();
                    let stderr = child.stderr.take().unwrap();

                    use std::io::Write;

                    // Thread STDOUT
                    {
                        let log = log.clone();
                        thread::spawn(move || {
                            let reader = BufReader::new(stdout);
                            for line in reader.lines().flatten() {
                                let mut file = log.lock().unwrap();
                                writeln!(file, "[STDOUT] {}", line).unwrap();
                            }
                        });
                    }

                    // Thread STDERR
                    {
                        let log = log.clone();
                        thread::spawn(move || {
                            let reader = BufReader::new(stderr);
                            for line in reader.lines().flatten() {
                                let mut file = log.lock().unwrap();
                                writeln!(file, "[STDERR] {}", line).unwrap();
                            }
                        });
                    }
                }
            }
        }

        child
    }
}

impl<A> Args for Agent<A>
where
    A: AgentArgs,
{
    fn args(self) -> BTreeMap<String, String> {
        let mut args = self.agent.args(self.chains);
        args.extend(self.chains_args);
        args.extend(self.db.args());
        args.extend(self.metrics_port.args());
        args.extend(self.log_format.args());
        args.extend(self.log_level.args());
        args
    }
}

pub fn workspace() -> PathBuf {
    MetadataCommand::new()
        .exec()
        .unwrap()
        .workspace_root
        .into_std_path_buf()
}

fn tempdir() -> String {
    TempDir::new().unwrap().path().to_string_lossy().to_string()
}

pub fn build_agents() {
    println!("Building agents...");
    Command::new("cargo")
        .args(&["build", "--bin", "validator", "--bin", "relayer"])
        .current_dir(workspace())
        .spawn()
        .unwrap()
        .wait()
        .unwrap();

    println!("Agents built successfully!");
}

// ---- ARGS ----

pub enum Location2 {
    Temp,
    Persistent(PathBuf),
}

impl Location2 {
    pub fn get_path(self) -> String {
        match self {
            Location2::Temp => tempdir(),
            Location2::Persistent(path) => {
                if !path.exists() {
                    fs::create_dir_all(&path).unwrap();
                }
                path.to_string_lossy().to_string()
            }
        }
    }
}

pub struct Db2(Location2);

impl Args for Db2 {
    fn args(self) -> BTreeMap<String, String> {
        btree_map! {
            "db".to_string() => self.0.get_path(),
        }
    }
}

pub struct MetricsPort2(u16);

impl Args for MetricsPort2 {
    fn args(self) -> BTreeMap<String, String> {
        btree_map! {
            "metrics-port".to_string() => self.0.to_string(),
        }
    }
}

#[derive(Clone)]
pub enum Piped {
    File(PathBuf),
}

pub enum LogFormat {
    Pretty,
    Json,
    Full,
    Compact,
}

impl Args for LogFormat {
    fn args(self) -> BTreeMap<String, String> {
        btree_map! {
            "log.format".to_string() => match self {
                LogFormat::Pretty => "pretty".to_string(),
                LogFormat::Json => "json".to_string(),
                LogFormat::Full => "full".to_string(),
                LogFormat::Compact => "compact".to_string(),
            },
        }
    }
}

pub enum LogLevel {
    DependencyTrace,
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Off,
}

impl Args for LogLevel {
    fn args(self) -> BTreeMap<String, String> {
        btree_map! {
            "log.level".to_string() => match self {
                LogLevel::DependencyTrace => "dependencyTrace".to_string(),
                LogLevel::Trace => "trace".to_string(),
                LogLevel::Debug => "debug".to_string(),
                LogLevel::Info => "info".to_string(),
                LogLevel::Warn => "warn".to_string(),
                LogLevel::Error => "error".to_string(),
                LogLevel::Off => "off".to_string(),
            },
        }
    }
}
