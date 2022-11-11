//! Settings and configuration for Abacus agents
//!
//! ## Introduction
//!
//! Abacus Agents have a shared core, which contains connection info for rpc,
//! relevant contract addresses on each chain, etc. In addition, each agent has
//! agent-specific settings. Be convention, we represent these as a base config
//! per-Outbox contract, and a "partial" config per agent. On bootup, the agent
//! loads the configuration, establishes RPC connections, and monitors each
//! configured chain.
//!
//! All agents share the [`Settings`] struct in this crate, and then define any
//! additional `Settings` in their own crate. By convention this is done in
//! `settings.rs` using the [`decl_settings!`] macro.
//!
//! ### Configuration
//!
//! Agents read settings from the config files and/or env.
//!
//! Config files are loaded from `rust/config/default` unless specified
//! otherwise, i.e.  via $RUN_ENV and $BASE_CONFIG (see the definition of
//! `decl_settings` in `rust/abacus-base/src/macros.rs`).
//!
//! #### N.B.: Environment variable names correspond 1:1 with cfg file's JSON object hierarchy.
//!
//! In particular, note that any environment variables whose names are prefixed
//! with:
//!
//! * `HYP_BASE`
//!
//! * `HYP_[agentname]`, where `[agentmame]` is agent-specific, e.g.
//!   `HYP_VALIDATOR` or `HYP_RELAYER`.
//!
//! will be read as an override to be applied against the hierarchical structure
//! of the configuration provided by the json config file at
//! `./config/$RUN_ENV/$BASE_CONFIG`.
//!
//! For example, if the config file `example_config.json` is:
//!
//! ```json
//! {
//!   "environment": "test",
//!   "signers": {},
//!   "inboxes": {
//!     "test2": {
//!       "domain": "13372",
//!       ...
//!     },
//!     ...
//!   },
//! }
//! ```
//!
//! and an environment variable is supplied which defines
//! `HYP_BASE_INBOXES_TEST3_DOMAIN=1`, then the `decl_settings` macro in
//! `rust/abacus-base/src/macros.rs` will directly override the 'domain' field
//! found in the json config to be `1`, since the fields in the environment
//! variable name describe the path traversal to arrive at this field in the
//! JSON config object.
//!
//! ### Configuration value precedence
//!
//! Configuration key/value pairs are loaded in the following order, with later
//! sources taking precedence:
//!
//! 1. The config file specified by the `RUN_ENV` and `BASE_CONFIG`
//!    env vars. `$RUN_ENV/$BASE_CONFIG`
//! 2. The config file specified by the `RUN_ENV` env var and the
//!    agent's name. `$RUN_ENV/{agent}-partial.json`.
//!    E.g. `$RUN_ENV/validator-partial.json`
//! 3. Configuration env vars with the prefix `HYP_BASE` intended
//!    to be shared by multiple agents in the same environment
//!    E.g. `export HYP_BASE_INBOXES_KOVAN_DOMAIN=3000`
//! 4. Configuration env vars with the prefix `HYP_{agent name}`
//!    intended to be used by a specific agent.
//!    E.g. `export HYP_KATHY_CHAT_TYPE="static message"`

use std::{collections::HashMap, env, sync::Arc};

use config::{Config, ConfigError, Environment, File};
use ethers::prelude::AwsSigner;
use eyre::{bail, Context, Report};
use once_cell::sync::OnceCell;
use rusoto_core::{credential::EnvironmentProvider, HttpClient};
use rusoto_kms::KmsClient;
use serde::Deserialize;
use tracing::instrument;

use abacus_core::{
    db::{AbacusDB, DB},
    utils::HexString,
    ContractLocator, InterchainGasPaymasterIndexer, MailboxIndexer, Signers,
};
use abacus_ethereum::{
    InterchainGasPaymasterIndexerBuilder, MailboxIndexerBuilder, MakeableWithProvider,
};
pub use chains::{ChainConf, ChainSetup, CoreContractAddresses};

use crate::{settings::trace::TracingConfig, CachingInterchainGasPaymaster, CachingMultisigModule};
use crate::{AbacusAgentCore, CachingMailbox, CoreMetrics};

use self::chains::GelatoConf;

/// Chain configuration
pub mod chains;

/// Tracing subscriber management
pub mod trace;

static KMS_CLIENT: OnceCell<KmsClient> = OnceCell::new();

/// Load a settings object from the config locations.
///
/// Read settings from the config files and/or env
/// The config will be located at `config/default` unless specified
/// otherwise
///
/// Configs are loaded in the following precedence order:
///
/// 1. The file specified by the `RUN_ENV` and `BASE_CONFIG`
///    env vars. `RUN_ENV/BASE_CONFIG`
/// 2. The file specified by the `RUN_ENV` env var and the
///    agent's name. `RUN_ENV/<agent_prefix>-partial.json`
/// 3. Configuration env vars with the prefix `HYP_BASE` intended
///    to be shared by multiple agents in the same environment
/// 4. Configuration env vars with the prefix `HYP_<agent_prefix>`
///    intended to be used by a specific agent.
///
/// Specify a configuration directory with the `RUN_ENV` env
/// variable. Specify a configuration file with the `BASE_CONFIG`
/// env variable.
pub fn load_settings_object<'de, T: Deserialize<'de>, S: AsRef<str>>(
    agent_prefix: &str,
    config_file_name: Option<&str>,
    ignore_prefixes: &[S],
) -> eyre::Result<T> {
    let env = env::var("RUN_ENV").unwrap_or_else(|_| "default".into());

    // Derive additional prefix from agent name
    let prefix = format!("HYP_{}", agent_prefix).to_ascii_uppercase();

    let filtered_env: HashMap<String, String> = env::vars()
        .filter(|(k, _v)| {
            !ignore_prefixes
                .iter()
                .any(|prefix| k.starts_with(prefix.as_ref()))
        })
        .collect();

    let builder = Config::builder();
    let builder = if let Some(fname) = config_file_name {
        builder.add_source(File::with_name(&format!("./config/{}/{}", env, fname)))
    } else {
        builder
    };
    let config_deserializer = builder
        .add_source(
            File::with_name(&format!(
                "./config/{}/{}-partial",
                env,
                agent_prefix.to_lowercase()
            ))
            .required(false),
        )
        // Use a base configuration env variable prefix
        .add_source(
            Environment::with_prefix("HYP_BASE")
                .separator("_")
                .source(Some(filtered_env.clone())),
        )
        .add_source(
            Environment::with_prefix(&prefix)
                .separator("_")
                .source(Some(filtered_env)),
        )
        .build()?;

    Ok(serde_path_to_error::deserialize(config_deserializer)?)
}

/// Ethereum signer types
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SignerConf {
    /// A local hex key
    HexKey {
        /// Hex string of private key, without 0x prefix
        key: HexString<64>,
    },
    /// An AWS signer. Note that AWS credentials must be inserted into the env
    /// separately.
    Aws {
        /// The UUID identifying the AWS KMS Key
        id: String, // change to no _ so we can set by env
        /// The AWS region
        region: String,
    },
    #[serde(other)]
    /// Assume node will sign on RPC calls
    Node,
}

impl Default for SignerConf {
    fn default() -> Self {
        Self::Node
    }
}

impl SignerConf {
    /// Try to convert the ethereum signer to a local wallet
    #[instrument(err)]
    pub async fn try_into_signer(&self) -> Result<Signers, Report> {
        match self {
            SignerConf::HexKey { key } => Ok(Signers::Local(key.as_ref().parse()?)),
            SignerConf::Aws { id, region } => {
                let client = KMS_CLIENT.get_or_init(|| {
                    KmsClient::new_with_client(
                        rusoto_core::Client::new_with(
                            EnvironmentProvider::default(),
                            HttpClient::new().unwrap(),
                        ),
                        region.parse().expect("invalid region"),
                    )
                });

                let signer = AwsSigner::new(client, id, 0).await?;
                Ok(Signers::Aws(signer))
            }
            SignerConf::Node => bail!("Node signer"),
        }
    }
}

/// Settings. Usually this should be treated as a base config and used as
/// follows:
///
/// ```
/// use abacus_base::*;
/// use serde::Deserialize;
///
/// pub struct OtherSettings { /* anything */ };
///
/// #[derive(Debug, Deserialize)]
/// pub struct MySettings {
///     #[serde(flatten)]
///     base_settings: Settings,
///     #[serde(flatten)]
///     other_settings: (),
/// }
///
/// // Make sure to define MySettings::new()
/// impl MySettings {
///     fn new() -> Self {
///         unimplemented!()
///     }
/// }
/// ```
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// The path to use for the DB file
    pub db: String,
    /// Port to listen for prometheus scrape requests
    pub metrics: Option<String>,
    /// Configuration for contracts on each chain
    pub chains: HashMap<String, ChainSetup>,
    /// The tracing configuration
    pub tracing: TracingConfig,
    /// Transaction signers
    pub signers: HashMap<String, SignerConf>,
    /// Gelato config
    pub gelato: Option<GelatoConf>,
}

impl Settings {
    /// Private to preserve linearity of AgentCore::from_settings -- creating an
    /// agent consumes the settings.
    fn clone(&self) -> Self {
        Self {
            db: self.db.clone(),
            metrics: self.metrics.clone(),
            chains: self.chains.clone(),
            tracing: self.tracing.clone(),
            signers: self.signers.clone(),
            gelato: self.gelato.clone(),
        }
    }
}

impl Settings {
    /// Try to get a signer instance by name
    pub async fn get_signer(&self, name: &str) -> Option<Signers> {
        self.signers.get(name)?.try_into_signer().await.ok()
    }

    /// Try to get a map of chain name -> mailbox contract
    pub async fn try_into_mailboxes(
        &self,
        db: DB,
        metrics: &CoreMetrics,
        chain_names: &[&String],
    ) -> eyre::Result<HashMap<String, CachingMailbox>> {
        let mut result = HashMap::new();
        for chain_name in chain_names {
            let setup = self.chains.get(*chain_name);
            match setup {
                Some(x) => {
                    let mailbox = self.try_caching_mailbox(x, db.clone(), metrics).await?;
                    result.insert((*chain_name).clone(), mailbox);
                }
                None => bail!("No chain setup found for {}", chain_name),
            }
        }
        Ok(result)
    }

    /// Try to get a map of chain name -> interchain gas paymaster contract
    pub async fn try_into_interchain_gas_paymasters(
        &self,
        db: DB,
        metrics: &CoreMetrics,
        chain_names: &[&String],
    ) -> eyre::Result<HashMap<String, CachingInterchainGasPaymaster>> {
        let mut result = HashMap::new();
        for chain_name in chain_names {
            let setup = self.chains.get(*chain_name);
            match setup {
                Some(x) => {
                    let mailbox = self
                        .try_caching_interchain_gas_paymaster(x, db.clone(), metrics)
                        .await?;
                    result.insert((*chain_name).clone(), mailbox);
                }
                None => bail!("No chain setup found for {}", chain_name),
            }
        }
        Ok(result)
    }

    /// Try to get a map of chain name -> multisig module contract
    pub async fn try_into_multisig_modules(
        &self,
        db: DB,
        metrics: &CoreMetrics,
        chain_names: &[&String],
    ) -> eyre::Result<HashMap<String, CachingMultisigModule>> {
        let mut result = HashMap::new();
        for chain_name in chain_names {
            let setup = self.chains.get(*chain_name);
            match setup {
                Some(x) => {
                    let multisig_module = self
                        .try_caching_multisig_module(x, db.clone(), metrics)
                        .await?;
                    result.insert((*chain_name).clone(), multisig_module);
                }
                None => bail!("No chain setup found for {}", chain_name),
            }
        }
        Ok(result)
    }

    /// Try to get a CachingMailbox
    async fn try_caching_mailbox(
        &self,
        chain_setup: &ChainSetup,
        db: DB,
        metrics: &CoreMetrics,
    ) -> eyre::Result<CachingMailbox> {
        let signer = self.get_signer(&chain_setup.name).await;
        let mailbox = chain_setup.try_into_mailbox(signer, metrics).await?;
        let indexer = self.try_mailbox_indexer(metrics, chain_setup).await?;
        let abacus_db = AbacusDB::new(&chain_setup.name, db);
        Ok(CachingMailbox::new(
            mailbox.into(),
            abacus_db,
            indexer.into(),
        ))
    }

    /// Try to get a CachingInterchainGasPaymaster
    async fn try_caching_interchain_gas_paymaster(
        &self,
        chain_setup: &ChainSetup,
        db: DB,
        metrics: &CoreMetrics,
    ) -> eyre::Result<CachingInterchainGasPaymaster> {
        let signer = self.get_signer(&chain_setup.name).await;
        let interchain_gas_paymaster = chain_setup
            .try_into_interchain_gas_paymaster(signer, metrics)
            .await?;
        let indexer = self
            .try_interchain_gas_paymaster_indexer(metrics, chain_setup)
            .await?;
        let abacus_db = AbacusDB::new(&chain_setup.name, db);
        Ok(CachingInterchainGasPaymaster::new(
            interchain_gas_paymaster.into(),
            abacus_db,
            indexer.into(),
        ))
    }

    /// Try to get a CachingMultisigModule
    async fn try_caching_multisig_module(
        &self,
        chain_setup: &ChainSetup,
        _db: DB,
        metrics: &CoreMetrics,
    ) -> eyre::Result<CachingMultisigModule> {
        let signer = self.get_signer(&chain_setup.name).await;
        let multisig_module = chain_setup
            .try_into_multisig_module(signer, metrics)
            .await?;
        Ok(CachingMultisigModule::new(multisig_module.into()))
    }

    /// Try to get an indexer object for a given mailbox
    pub async fn try_mailbox_indexer(
        &self,
        metrics: &CoreMetrics,
        chain_setup: &ChainSetup,
    ) -> eyre::Result<Box<dyn MailboxIndexer>> {
        match &chain_setup.chain {
            ChainConf::Ethereum(conn) => Ok(MailboxIndexerBuilder {
                finality_blocks: chain_setup.finality_blocks(),
            }
            .make_with_connection(
                conn.clone(),
                &ContractLocator {
                    chain_name: chain_setup.name.clone(),
                    domain: chain_setup.domain.parse().expect("invalid uint"),
                    address: chain_setup
                        .addresses
                        .mailbox
                        .parse::<ethers::types::Address>()?
                        .into(),
                },
                self.get_signer(&chain_setup.name).await,
                Some(|| metrics.json_rpc_client_metrics()),
                Some((metrics.provider_metrics(), chain_setup.metrics_conf())),
            )
            .await?),
        }
    }

    /// Try to get an indexer object for a given interchain gas paymaster
    async fn try_interchain_gas_paymaster_indexer(
        &self,
        metrics: &CoreMetrics,
        chain_setup: &ChainSetup,
    ) -> eyre::Result<Box<dyn InterchainGasPaymasterIndexer>> {
        match &chain_setup.chain {
            ChainConf::Ethereum(conn) => Ok(InterchainGasPaymasterIndexerBuilder {
                mailbox_address: chain_setup
                    .addresses
                    .mailbox
                    .parse::<ethers::types::Address>()?,
                finality_blocks: chain_setup.finality_blocks(),
            }
            .make_with_connection(
                conn.clone(),
                &ContractLocator {
                    chain_name: chain_setup.name.clone(),
                    domain: chain_setup.domain.parse().expect("invalid uint"),
                    address: chain_setup
                        .addresses
                        .interchain_gas_paymaster
                        .parse::<ethers::types::Address>()?
                        .into(),
                },
                self.get_signer(&chain_setup.name).await,
                Some(|| metrics.json_rpc_client_metrics()),
                Some((metrics.provider_metrics(), chain_setup.metrics_conf())),
            )
            .await?),
        }
    }
}

impl AgentSettings {
    /// Create the core metrics from the settings given the name of the agent.
    pub fn try_into_metrics(&self, name: &str) -> eyre::Result<Arc<CoreMetrics>> {
        Ok(Arc::new(CoreMetrics::new(
            name,
            self.metrics
                .as_ref()
                .map(|v| v.parse::<u16>().context("Port must be a valid u16"))
                .transpose()?,
            prometheus::Registry::new(),
        )?))
    }
}

/// Settings. Usually this should be treated as a base config and used as
/// follows:
///
/// ```
/// use abacus_base::*;
/// use serde::Deserialize;
///
/// pub struct OtherSettings { /* anything */ };
///
/// #[derive(Debug, Deserialize)]
/// pub struct MySettings {
///     #[serde(flatten)]
///     base_settings: Settings,
///     #[serde(flatten)]
///     other_settings: (),
/// }
///
/// // Make sure to define MySettings::new()
/// impl MySettings {
///     fn new() -> Self {
///         unimplemented!()
///     }
/// }
/// ```
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Settings specific to a given chain
    #[serde(flatten)]
    pub chain: DomainSettings,
    /// Settings for the application as a whole
    #[serde(flatten)]
    pub app: AgentSettings,
}

impl Settings {
    /// Private to preserve linearity of AgentCore::from_settings -- creating an
    /// agent consumes the settings.
    fn clone(&self) -> Self {
        Self {
            chain: DomainSettings {
                index: self.chain.index.clone(),
                outbox: self.chain.outbox.clone(),
                inboxes: self.chain.inboxes.clone(),
                signers: self.chain.signers.clone(),
                gelato: self.chain.gelato.clone(),
            },
            app: AgentSettings {
                db: self.app.db.clone(),
                metrics: self.app.metrics.clone(),
                tracing: self.app.tracing.clone(),
            },
        }
    }
}

impl AsRef<AgentSettings> for Settings {
    fn as_ref(&self) -> &AgentSettings {
        &self.app
    }
}

impl AsRef<DomainSettings> for Settings {
    fn as_ref(&self) -> &DomainSettings {
        &self.chain
    }
}

impl Settings {
    /// Try to generate an agent core for a named agent
    pub async fn try_into_abacus_core(
        &self,
        metrics: Arc<CoreMetrics>,
        chain_names: Option<Vec<&String>>,
    ) -> eyre::Result<AbacusAgentCore> {
        let db = DB::from_path(&self.db)?;

        // If not provided, default to using every chain listed in self.chains.
        let chain_names = match chain_names {
            Some(x) => x,
            None => Vec::from_iter(self.chains.keys()),
        };

        let mailboxes = self
            .try_into_mailboxes(db.clone(), &metrics, chain_names.as_slice())
            .await?;
        let interchain_gas_paymasters = self
            .try_into_interchain_gas_paymasters(db.clone(), &metrics, chain_names.as_slice())
            .await?;
        let multisig_modules = self
            .try_into_multisig_modules(db.clone(), &metrics, chain_names.as_slice())
            .await?;

        Ok(AbacusAgentCore {
            mailboxes,
            interchain_gas_paymasters,
            multisig_modules,
            db,
            metrics,
            settings: self.clone(),
        })
    }

    /// Read settings from the config file
    pub fn new() -> Result<Self, ConfigError> {
        let env_path = format!(
            "config/{}",
            env::var("RUN_MODE").as_deref().unwrap_or("development")
        );
        Config::builder()
            .add_source(File::with_name("config/default"))
            .add_source(File::with_name(&env_path))
            // Add in settings from the environment (with a prefix of ABACUS)
            // Eg.. `ABACUS_DEBUG=1 would set the `debug` key
            .add_source(Environment::with_prefix("ABACUS"))
            .build()?
            .try_deserialize()
    }
}
