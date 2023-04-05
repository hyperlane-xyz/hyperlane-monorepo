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

pub trait ConfigOptionExt<T> {
    fn expect_or_eyre<M: Into<String>>(self, msg: M) -> eyre::Result<T>;
    fn expect_or_else_eyre<S, F>(self, f: F) -> eyre::Result<T>
    where
        S: Into<String>,
        F: FnOnce() -> S;
    fn expect_or_parsing_error<S, F>(self, v: F) -> ConfigResult<T>
    where
        S: Into<String>,
        F: FnOnce() -> (ConfigPath, S);
}

impl<T> ConfigOptionExt<T> for Option<T> {
    fn expect_or_eyre<M: Into<String>>(self, msg: M) -> eyre::Result<T> {
        self.ok_or_else(|| eyre!(msg.into()))
    }

    fn expect_or_else_eyre<S, F>(self, f: F) -> eyre::Result<T>
    where
        S: Into<String>,
        F: FnOnce() -> S,
    {
        self.ok_or_else(|| eyre!(f().into()))
    }

    fn expect_or_parsing_error<S, F>(self, v: F) -> ConfigResult<T>
    where
        S: Into<String>,
        F: FnOnce() -> (ConfigPath, S),
    {
        self.ok_or_else(|| {
            let (path, msg) = v();
            ConfigParsingError::new(path, eyre!(msg.into()))
        })
    }
}

pub trait ConfigErrResultExt<T> {
    fn into_config_result(self, path: impl FnOnce() -> ConfigPath) -> ConfigResult<T>;

    fn merge_err_then_none(
        self,
        err: &mut ConfigParsingError,
        path: impl FnOnce() -> ConfigPath,
    ) -> Option<T>;

    fn merge_err_with_ctx_then_none<S, F>(self, err: &mut ConfigParsingError, ctx: F) -> Option<T>
    where
        S: Into<String>,
        F: FnOnce() -> (ConfigPath, S);
}

impl<T, E> ConfigErrResultExt<T> for Result<T, E>
where
    E: Into<Report>,
{
    fn into_config_result(self, path: impl FnOnce() -> ConfigPath) -> ConfigResult<T> {
        self.map_err(|e| ConfigParsingError::new(path(), e.into()))
    }

    fn merge_err_then_none(
        self,
        err: &mut ConfigParsingError,
        path: impl FnOnce() -> ConfigPath,
    ) -> Option<T> {
        match self {
            Ok(v) => Some(v),
            Err(e) => {
                err.merge(ConfigParsingError::new(path(), e));
                None
            }
        }
    }

    fn merge_err_with_ctx_then_none<S, F>(self, err: &mut ConfigParsingError, ctx: F) -> Option<T>
    where
        S: Into<String>,
        F: FnOnce() -> (ConfigPath, S),
    {
        match self {
            Ok(v) => Some(v),
            Err(e) => {
                let (path, ctx) = ctx();
                let report: Report = Err::<(), _>(e.into()).context(ctx.into()).err().unwrap();
                err.merge(ConfigParsingError::new(path, report));
                None
            }
        }
    }
}

pub trait ConfigResultExt<T> {
    fn merge_parsing_err_then_none(self, err: &mut ConfigParsingError) -> Option<T>;
}

impl<T> ConfigResultExt<T> for ConfigResult<T> {
    fn merge_parsing_err_then_none(self, err: &mut ConfigParsingError) -> Option<T> {
        match self {
            Ok(v) => Some(v),
            Err(e) => {
                err.merge(e);
                None
            }
        }
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
pub struct ConfigParsingError(Vec<(ConfigPath, Report)>);

impl ConfigParsingError {
    pub fn new(path: ConfigPath, report: impl Into<Report>) -> Self {
        Self(vec![(path, report.into())])
    }

    pub fn from_report(conf_path: ConfigPath, report: Report) -> Self {
        Self(vec![(conf_path, report)])
    }

    pub fn push(&mut self, conf_path: ConfigPath, report: Report) {
        self.0.push((conf_path, report));
    }

    pub fn merge(&mut self, other: Self) {
        self.0.extend(other.0);
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

pub type ConfigResult<T> = Result<T, ConfigParsingError>;

impl FromIterator<ConfigParsingError> for ConfigParsingError {
    fn from_iter<T: IntoIterator<Item = ConfigParsingError>>(iter: T) -> Self {
        Self(iter.into_iter().flat_map(|e| e.0).collect())
    }
}

impl Display for ConfigParsingError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "ParsingError [")?;
        for (path, report) in &self.0 {
            write!(f, "({path}: {report}),")?;
        }
        write!(f, "]")
    }
}

impl std::error::Error for ConfigParsingError {}

pub trait FromRawConf<'de, T>: Sized
where
    T: Debug + Deserialize<'de>,
{
    fn from_config(raw: T, cwp: &ConfigPath) -> ConfigResult<Self>;
}

pub trait IntoParsedConf<'de>: Debug + Deserialize<'de> {
    type Output: Sized;

    fn parse_config(self, cwp: &ConfigPath) -> ConfigResult<Self::Output>;
}

impl<'de, T> IntoParsedConf<'de> for T
where
    T: FromRawConf<'de, Self> + Debug + Deserialize<'de>,
{
    type Output = T;

    fn parse_config(self, cwp: &ConfigPath) -> ConfigResult<Self::Output> {
        T::from_config(self, cwp)
    }
}

// #[macro_export]
// macro_rules! declare_config_struct {
//     {$(#[$struct_attrib:meta])* $(#r[$raw_struct_attrib:meta])*
// $struct_vis:vis struct $struct_name:ident {         $($(#[$field_attrib:
// meta])* $field_vis:vis $field_name:ident: $field_type:ty =
// {$($(#[$raw_attrib:meta])* $raw_vis:vis $raw_name:ident:
// $raw_type:ty),+$(,)?}),*$(,)?     }} => {paste::paste!{
//         $(#[$struct_attrib])*
//         $struct_vis struct $struct_name {
//             $($(#[$field_attrib])* $field_vis $field_name: $field_type),*
//         }
//
//         $(#[$raw_struct_attrib])*
//         #[derive(Debug, Deserialize)]
//         #[serde(rename_all = "camelCase")]
//         $struct_vis struct [< Raw $struct_name >] {
//             $($(
//                 $(#[$raw_attrib])* $raw_vis $raw_name: $raw_type,
//             )*)*
//         }
//
//         static_assertions::assert_impl_all!($struct_name:
// $crate::FromRawConf<[< Raw $struct_name >]>);
//
//         // impl<'de> FromRawConf<'de, [< Raw $struct_name >]> for
// $struct_name {         //     fn from_config(__raw: [< Raw $struct_name >],
// cwp: &ConfigPath) -> Result<Self, ParsingError> {         //         let mut
// __err = ParsingError::default();         //
//         //         // parse each of the fields
//         //         $(let $field_name: Result<$field_type, ParsingError> = {
//         //             // set values expected by the parse code
//         //             $(let $raw_name: $raw_type = __raw.$raw_name;)*
//         //             // use closure to capture any error unwrapping as a
// result instead of returning         //             (|| $parse)()
//         //         };)*
//         //
//         //         // merge errors for each of the fields
//         //         $(
//         //             if let Err(e) = $field_name {
//         //                 __err.merge(e);
//         //             }
//         //         )*
//         //
//         //         // report the results
//         //         if __err.is_empty() {
//         //             Ok(Self {$(
//         //                 $field_name: $field_name.unwrap(),
//         //             )*})
//         //         } else {
//         //             Err(__err)
//         //         }
//         //     }
//         // }
//     }};
// }
