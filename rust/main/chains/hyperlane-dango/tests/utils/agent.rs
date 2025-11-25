use {
    crate::utils::dango_helper::{ChainHelper, IntoSignerConf},
    cargo_metadata::MetadataCommand,
    dango_types::config::AppAddresses,
    grug::JsonSerExt,
    hyperlane_base::settings::SignerConf,
    hyperlane_core::H256,
    hyperlane_dango::DangoConvertor,
    std::{
        collections::{BTreeMap, BTreeSet},
        fs,
        path::{Path, PathBuf},
        process::{Child, Command},
        vec,
    },
    tempfile::TempDir,
    tracing::info,
};

pub enum Location {
    Temp,
    Persistent(PathBuf),
}

impl Location {
    pub fn persistent<P: AsRef<Path>>(path: P) -> Self {
        Self::Persistent(path.as_ref().to_path_buf())
    }
}

#[derive(Default)]
pub struct AgentBuilder<'a> {
    agent: Agent,
    addresses: BTreeMap<&'a str, AppAddresses>,
    checkpoint_syncer: Option<CheckpointSyncer>,
    origin_chain_name: Option<OriginChainName>,
    allow_local_checkpoint_syncer: Option<AllowLocalCheckpointSyncer>,
    chain_signers: BTreeMap<&'a str, SignerConf>,
    validator_signer: Option<ValidatorSigner>,
    relay_chains: Option<RelayChains<'a>>,
    metrics_port: Option<MetricsPort>,
    db: Option<Db>,
    chain_helpers: BTreeMap<&'a str, &'a ChainHelper>,
}

impl<'a> AgentBuilder<'a> {
    pub fn new(agent: Agent) -> Self {
        Self {
            agent,
            ..Default::default()
        }
    }

    pub fn with_addresses(mut self, chain: &'a str, addresses: AppAddresses) -> Self {
        self.addresses.insert(chain, addresses);
        self
    }

    pub fn with_chain_helper(mut self, chain: &'a str, chain_helper: &'a ChainHelper) -> Self {
        self.chain_helpers.insert(chain, chain_helper);
        self
    }

    pub fn with_origin_chain_name(mut self, origin_chain_name: &str) -> Self {
        self.origin_chain_name = Some(OriginChainName(origin_chain_name.to_string()));
        self
    }

    pub fn with_checkpoint_syncer(mut self, location: Location) -> Self {
        self.checkpoint_syncer = Some(CheckpointSyncer(location));
        self
    }

    pub fn with_validator_signer(mut self, hex_key: H256) -> Self {
        self.validator_signer = Some(ValidatorSigner(SignerConf::HexKey { key: hex_key }));
        self
    }

    pub fn with_allow_local_checkpoint_syncer(
        mut self,
        allow_local_checkpoint_syncer: bool,
    ) -> Self {
        self.allow_local_checkpoint_syncer =
            Some(AllowLocalCheckpointSyncer(allow_local_checkpoint_syncer));
        self
    }

    pub fn with_chain_signer<S>(mut self, chain: &'a str, signer: S) -> Self
    where
        S: IntoSignerConf,
    {
        self.chain_signers.insert(chain, signer.as_signer_conf());
        self
    }

    pub fn with_relay_chains(mut self, relay_chains: BTreeSet<&'a str>) -> Self {
        self.relay_chains = Some(RelayChains(relay_chains));
        self
    }

    pub fn with_metrics_port(mut self, metrics_port: u16) -> Self {
        self.metrics_port = Some(MetricsPort(metrics_port));
        self
    }

    pub fn launch(self) -> Child {
        let path = format!("./target/debug/{}", self.agent.args().first().unwrap());

        let mut cmd = Command::new(path);

        cmd.args(self.chain_helpers.args())
            .args(self.addresses.args())
            .args(self.origin_chain_name.args())
            .args(self.db.unwrap_or_default().args())
            .args(self.checkpoint_syncer.args())
            .args(self.chain_signers.args())
            .args(self.validator_signer.args())
            .args(self.relay_chains.args())
            .args(self.allow_local_checkpoint_syncer.args())
            .args(self.metrics_port.args())
            .current_dir(workspace());

        println!("{:?}", cmd.get_args());

        cmd.spawn().unwrap()

        // .spawn()
        // .unwrap()
    }
}

// -------------------------------- Args trait ---------------------------------

struct CheckpointSyncer(Location);

pub trait Args {
    fn args(self) -> Vec<String>;
}

impl Args for CheckpointSyncer {
    fn args(self) -> Vec<String> {
        match self.0 {
            Location::Temp => {
                vec![
                    "--checkpointSyncer.type".to_string(),
                    "localStorage".to_string(),
                    "--checkpointSyncer.path".to_string(),
                    tempdir(),
                ]
            }
            Location::Persistent(path) => {
                vec![
                    "--checkpointSyncer.type".to_string(),
                    "localStorage".to_string(),
                    "--checkpointSyncer.path".to_string(),
                    path.to_string_lossy().to_string(),
                ]
            }
        }
    }
}

impl<T> Args for Option<T>
where
    T: Args,
{
    fn args(self) -> Vec<String> {
        match self {
            Some(inner) => inner.args(),
            None => vec![],
        }
    }
}

impl Args for BTreeMap<&str, SignerConf> {
    fn args(self) -> Vec<String> {
        self.into_iter()
            .flat_map(|(chain, signer)| {
                ChainSigner {
                    chain: chain.to_string(),
                    signer,
                }
                .args()
            })
            .collect()
    }
}

#[derive(Default, Clone, Copy)]
pub enum Agent {
    #[default]
    Validator,
    Relayer,
}

impl Args for Agent {
    fn args(self) -> Vec<String> {
        match self {
            Self::Validator => vec!["validator".to_owned()],
            Self::Relayer => vec!["relayer".to_owned()],
        }
    }
}

pub struct HttpdUrl(String);

impl Args for HttpdUrl {
    fn args(self) -> Vec<String> {
        vec!["--httpd_url".to_string(), self.0]
    }
}

#[derive(Clone)]
struct OriginChainName(String);

impl Args for OriginChainName {
    fn args(self) -> Vec<String> {
        vec!["--origin-chain-name".to_string(), self.0]
    }
}

pub struct ValidatorSigner(SignerConf);

impl Args for ValidatorSigner {
    fn args(self) -> Vec<String> {
        with_signer_config("validator", self.0)
    }
}

fn with_signer_config(prepath: &str, signer_conf: SignerConf) -> Vec<String> {
    match signer_conf {
        SignerConf::HexKey { key } => vec![
            format!("--{prepath}.type"),
            "hexKey".to_string(),
            format!("--{prepath}.key"),
            format!("{:?}", key),
        ],

        SignerConf::Dango {
            username,
            key,
            address,
        } => vec![
            format!("--{prepath}.type"),
            "dangoKey".to_string(),
            format!("--{prepath}.username"),
            username.to_string(),
            format!("--{prepath}.key"),
            key.to_string(),
            format!("--{prepath}.address"),
            address.to_string(),
        ],
        _ => unimplemented!(),
    }
}

pub struct ChainSigner {
    chain: String,
    signer: SignerConf,
}

impl Args for ChainSigner {
    fn args(self) -> Vec<String> {
        with_signer_config(&format!("chains.{}.signer", self.chain), self.signer)
    }
}

pub struct RelayChains<'a>(BTreeSet<&'a str>);

impl Args for RelayChains<'_> {
    fn args(self) -> Vec<String> {
        vec![
            "--relayChains".to_string(),
            self.0.into_iter().collect::<Vec<_>>().join(","),
        ]
    }
}

pub struct AllowLocalCheckpointSyncer(bool);

impl Args for AllowLocalCheckpointSyncer {
    fn args(self) -> Vec<String> {
        vec![
            "--allowLocalCheckpointSyncers".to_string(),
            self.0.to_string(),
        ]
    }
}

pub struct MetricsPort(u16);

impl Args for MetricsPort {
    fn args(self) -> Vec<String> {
        vec!["--metrics-port".to_string(), self.0.to_string()]
    }
}

pub struct Db(Location);

impl Default for Db {
    fn default() -> Self {
        Self(Location::Temp)
    }
}

impl Args for Db {
    fn args(self) -> Vec<String> {
        let path = match self.0 {
            Location::Temp => tempdir(),
            Location::Persistent(path) => {
                if !path.exists() {
                    fs::create_dir_all(&path).unwrap();
                }
                path.to_string_lossy().to_string()
            }
        };

        vec!["--db".to_string(), path]
    }
}

#[derive(Clone)]
pub struct Addresses {
    addresses: AppAddresses,
    chain: String,
}

impl Args for Addresses {
    fn args(self) -> Vec<String> {
        vec![
            format!("--chains.{}.mailbox", self.chain),
            format!(
                "{:?}",
                DangoConvertor::<H256>::convert(self.addresses.hyperlane.mailbox)
            ),
            // Merkle tree hook is the same as mailbox for dango chain
            format!("--chains.{}.merkleTreeHook", self.chain),
            format!(
                "{:?}",
                DangoConvertor::<H256>::convert(self.addresses.hyperlane.mailbox)
            ),
            format!("--chains.{}.validatorAnnounce", self.chain),
            format!(
                "{:?}",
                DangoConvertor::<H256>::convert(self.addresses.hyperlane.va)
            ),
            // Interchain gas paymaster is not used on dango chain.
            format!("--chains.{}.interchainGasPaymaster", self.chain),
            format!("{:?}", H256::zero()),
        ]
    }
}

impl Args for BTreeMap<&str, AppAddresses> {
    fn args(self) -> Vec<String> {
        self.into_iter()
            .flat_map(|(chain, addresses)| {
                vec![
                    format!("--chains.{}.mailbox", chain),
                    format!(
                        "{:?}",
                        DangoConvertor::<H256>::convert(addresses.hyperlane.mailbox)
                    ),
                    // Merkle tree hook is the same as mailbox for dango chain
                    format!("--chains.{}.merkleTreeHook", chain),
                    format!(
                        "{:?}",
                        DangoConvertor::<H256>::convert(addresses.hyperlane.mailbox)
                    ),
                    format!("--chains.{}.validatorAnnounce", chain),
                    format!(
                        "{:?}",
                        DangoConvertor::<H256>::convert(addresses.hyperlane.va)
                    ),
                    // Interchain gas paymaster is not used on dango chain.
                    format!("--chains.{}.interchainGasPaymaster", chain),
                    format!("{:?}", H256::zero()),
                ]
            })
            .collect()
    }
}

impl Args for BTreeMap<&str, &ChainHelper> {
    fn args(self) -> Vec<String> {
        self.into_iter()
            .flat_map(|(chain, chain_helper)| {
                vec![
                    // Httpd url
                    format!("--chains.{chain}.httpd_urls"),
                    chain_helper.httpd_urls.to_json_string().unwrap(),
                    // Chain id
                    format!("--chains.{chain}.chainId"),
                    chain_helper.chain_id.clone(),
                    // Domain ID
                    format!("--chains.{chain}.domainId"),
                    chain_helper.hyperlane_domain.to_string(),
                    // Mailbox
                    format!("--chains.{chain}.mailbox"),
                    format!(
                        "{:?}",
                        DangoConvertor::<H256>::convert(
                            chain_helper.cfg.addresses.hyperlane.mailbox
                        )
                    ),
                    // Merkle tree hook is the same as mailbox for dango chain
                    format!("--chains.{chain}.merkleTreeHook"),
                    format!(
                        "{:?}",
                        DangoConvertor::<H256>::convert(
                            chain_helper.cfg.addresses.hyperlane.mailbox
                        )
                    ),
                    // Validator announce
                    format!("--chains.{chain}.validatorAnnounce"),
                    format!(
                        "{:?}",
                        DangoConvertor::<H256>::convert(chain_helper.cfg.addresses.hyperlane.va)
                    ),
                    // Interchain gas paymaster is not used on dango chain.
                    format!("--chains.{chain}.interchainGasPaymaster"),
                    format!("{:?}", H256::zero()),
                ]
            })
            .collect()
    }
}

fn tempdir() -> String {
    TempDir::new().unwrap().path().to_string_lossy().to_string()
}

fn workspace() -> PathBuf {
    MetadataCommand::new()
        .exec()
        .unwrap()
        .workspace_root
        .into_std_path_buf()
}

pub fn build_agents() {
    info!("Building agents...");
    Command::new("cargo")
        .args(&["build", "--bin", "validator", "--bin", "relayer"])
        .current_dir(workspace())
        .spawn()
        .unwrap()
        .wait()
        .unwrap();

    info!("Agents built successfully!");
}
