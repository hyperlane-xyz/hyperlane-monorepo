use {
    crate::utils::{AgentArgs, Args, ChainSettings, Launcher},
    cargo_metadata::MetadataCommand,
    grug::btree_map,
    std::{
        collections::{BTreeMap, BTreeSet},
        fs,
        path::PathBuf,
        process::{Child, Command},
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
}

impl<A> Agent<A>
where
    A: Launcher + AgentArgs,
{
    pub fn launch(self) -> Child {
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

        Command::new(format!("./target/debug/{}", A::PATH))
            .args(args)
            .current_dir(workspace())
            .spawn()
            .unwrap()
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
        args
    }
}

fn workspace() -> PathBuf {
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
