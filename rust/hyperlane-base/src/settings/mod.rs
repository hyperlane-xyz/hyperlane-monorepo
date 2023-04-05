//! Settings and configuration for Hyperlane agents
//!
//! ## Introduction
//!
//! Hyperlane Agents have a shared core, which contains connection info for rpc,
//! relevant contract addresses on each chain, etc. In addition, each agent has
//! agent-specific settings. By convention above, we represent these as a base
//! config per-Mailbox contract, and a "partial" config per agent. On bootup,
//! the agent loads the configuration, establishes RPC connections, and monitors
//! each configured chain.
//!
//! All agents share the [`Settings`] struct in this crate, and then define any
//! additional `Settings` in their own crate. By convention this is done in
//! `settings.rs` using the [`decl_settings!`] macro.
//!
//! ### Configuration
//!
//! Agents read settings from the config files and/or env from `config/<env?
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
//! `./config/<env>/<config>.json`.
//!
//! For example, if the config file `example_config.json` is:
//!
//! ```json
//! {
//!   "environment": "test",
//!   "signers": {},
//!   "chains": {
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
//! `HYP_BASE_CHAINS_TEST2_DOMAIN=1`, then the `decl_settings` macro in
//! `rust/hyperlane-base/src/macros.rs` will directly override the 'domain'
//! field found in the json config to be `1`, since the fields in the
//! environment variable name describe the path traversal to arrive at this
//! field in the JSON config object.
//!
//! ### Configuration value precedence
//!
//! Configuration key/value pairs are loaded in the following order, with later
//! sources taking precedence:
//!
//! 1. The files matching `config/<env>/<config>.json`.
//! 2. The order of configs in `CONFIG_FILES` with each sequential one
//!    overwriting previous ones as appropriate.
//! 3. Configuration env vars with the prefix `HYP_BASE` intended
//!    to be shared by multiple agents in the same environment
//!    E.g. `export HYP_BASE_INBOXES_KOVAN_DOMAIN=3000`
//! 4. Configuration env vars with the prefix `HYP_<agent_prefix>`
//!    intended to be used by a specific agent.
//!    E.g. `export HYP_RELAYER_ORIGINCHAIN="ethereum"`

use std::fmt::{Debug, Display, Formatter};
use std::ops::Deref;
use std::path::Path;
use std::rc::Rc;

use eyre::{eyre, Context, Report};
use futures_util::AsyncReadExt;
use itertools::Itertools;
use once_cell::sync::OnceCell;
use rusoto_kms::KmsClient;
use serde::Deserialize;

pub use base::*;
pub use chains::{ChainConf, ChainConnectionConf, CoreContractAddresses};
use hyperlane_core::{
    HyperlaneChain, HyperlaneProvider, InterchainGasPaymaster, InterchainGasPaymasterIndexer,
    Mailbox, MailboxIndexer, MultisigIsm, ValidatorAnnounce,
};
pub use signers::{RawSignerConf, SignerConf};

use crate::CachingInterchainGasPaymaster;
use crate::{CachingMailbox, CoreMetrics, HyperlaneAgentCore};

mod base;
/// Chain configuration
pub mod chains;
pub(crate) mod loader;
/// Signer configuration
mod signers;
/// Tracing subscriber management
pub mod trace;

static KMS_CLIENT: OnceCell<KmsClient> = OnceCell::new();

pub trait EyreOptionExt<T> {
    fn expect_or_eyre<M: Into<String>>(self, msg: M) -> eyre::Result<T>;
    fn expect_or_else_eyre(self, f: impl FnOnce() -> String) -> eyre::Result<T>;
}

impl<T> EyreOptionExt<T> for Option<T> {
    fn expect_or_eyre<M: Into<String>>(self, msg: M) -> eyre::Result<T> {
        self.ok_or_else(|| eyre!(msg.into()))
    }

    fn expect_or_else_eyre(self, f: impl FnOnce() -> String) -> eyre::Result<T> {
        self.ok_or_else(|| eyre!(f()))
    }
}

// declare_deserialize_for_config_struct!(Settings);

#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub struct ConfigPath(Vec<Rc<String>>);

impl Display for ConfigPath {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.path_name())
    }
}

impl ConfigPath {
    pub fn join(&self, part: impl Into<String>) -> Self {
        let part = part.into();
        debug_assert!(!part.contains('.'));
        let mut new = self.clone();
        new.0.push(Rc::new(part));
        new
    }

    pub fn merge(&self, other: &Self) -> Self {
        Self(
            self.0
                .iter()
                .cloned()
                .chain(other.0.iter().cloned())
                .collect(),
        )
    }

    pub fn path_name(&self) -> String {
        self.0.iter().map(|s| s.as_str()).join(".")
    }

    pub fn env_name(&self) -> String {
        ["HYP", "BASE"]
            .into_iter()
            .chain(self.0.iter().map(|s| s.as_str()))
            .map(|s| s.to_uppercase())
            .join("_")
    }
}

#[derive(Debug, Default)]
pub struct ParsingError(Vec<(ConfigPath, Report)>);

impl ParsingError {
    fn report(&mut self, conf_path: ConfigPath, report: Report) {
        self.0.push((conf_path, report));
    }
}

impl Display for ParsingError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "ParsingError [")?;
        for (path, report) in &self.0 {
            write!(f, "({path}: {report}),")?;
        }
        write!(f, "]")
    }
}

impl std::error::Error for ParsingError {}

pub trait FromRawConf<'de, T>: Sized
where
    T: Debug + Deserialize<'de>,
{
    fn from_config(raw: T, cwp: &Path) -> Result<Self, ParsingError>;
    fn path_as_env(config_path: &Path) -> String;
    fn path_as_json_path(config_path: &Path) -> String;
}

pub trait IntoParsedConf<'de>: Debug + Deserialize<'de> {
    type Output: Sized;

    fn parse_config(self, cwp: &Path) -> Result<Self::Output, ParsingError>;
}

impl<'de, T> IntoParsedConf<'de> for T
where
    T: FromRawConf<'de, Self> + Debug + Deserialize<'de>,
{
    type Output = T;

    fn parse_config(self, cwp: &Path) -> Result<Self::Output, ParsingError> {
        T::from_config(self, cwp)
    }
}
