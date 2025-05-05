//! A set of traits and types to make configuration parsing easier. The main
//! flow is to define a config struct and then a raw config struct which mirrors
//! it but is more forgiving for the deserialization, and then to implement
//! `FromRawConf` which will allow for better error messages.

use std::fmt::{Debug, Display, Formatter};

use async_trait::async_trait;
pub use config_path::ConfigPath;
use eyre::Report;
pub use str_or_int::{StrOrInt, StrOrIntParseError};
pub use trait_ext::*;

use crate::H256;

mod config_path;
mod str_or_int;
mod trait_ext;

/// A result type that is used for config parsing and may contain multiple
/// errors.
pub type ConfigResult<T> = Result<T, ConfigParsingError>;
/// A no-op filter type.
pub type NoFilter = ();

/// Config for batching messages
#[derive(Debug, Clone, Default)]
pub struct OpSubmissionConfig {
    /// Optional batch contract address (e.g. Multicall3 on EVM chains)
    pub batch_contract_address: Option<H256>,

    /// Batch size
    pub max_batch_size: u32,

    /// bypass batch simulation
    pub bypass_batch_simulation: bool,

    /// max submit queue length
    pub max_submit_queue_length: Option<u32>,
}

/// A trait that allows for constructing `Self` from a raw config type.
#[async_trait]
pub trait FromRawConf<T, F = NoFilter>: Sized
where
    T: Debug + Send + 'static,
    F: Default + Send,
{
    /// Construct `Self` from a raw config type.
    /// - `raw` is the raw config value
    /// - `cwp` is the current working path
    async fn from_config(raw: T, cwp: &ConfigPath) -> ConfigResult<Self> {
        Self::from_config_filtered(raw, cwp, F::default()).await
    }

    /// Construct `Self` from a raw config type with a filter to limit what
    /// config paths are used.
    /// - `raw` is the raw config value
    /// - `cwp` is the current working path
    /// - `filter` can define what config paths are parsed
    async fn from_config_filtered(raw: T, cwp: &ConfigPath, filter: F) -> ConfigResult<Self>;
}

/// A trait that allows for converting a raw config type into a "parsed" type.
#[async_trait]
pub trait IntoParsedConf<F: Default + Send + 'static>: Debug + Sized + Send + 'static {
    /// Parse the config with a filter to limit what config paths are used.
    async fn parse_config_with_filter<O: FromRawConf<Self, F>>(
        self,
        cwp: &ConfigPath,
        filter: F,
    ) -> ConfigResult<O>;

    /// Parse the config.
    async fn parse_config<O: FromRawConf<Self, F>>(self, cwp: &ConfigPath) -> ConfigResult<O> {
        self.parse_config_with_filter(cwp, F::default()).await
    }
}

#[async_trait]
impl<S, F> IntoParsedConf<F> for S
where
    S: Debug + Send + 'static,
    F: Default + Send + 'static,
{
    async fn parse_config_with_filter<O: FromRawConf<S, F>>(
        self,
        cwp: &ConfigPath,
        filter: F,
    ) -> ConfigResult<O> {
        O::from_config_filtered(self, cwp, filter).await
    }
}

/// A composite error type that allows for compiling multiple errors into a
/// single result. Use `default()` to create an empty error and then take other
/// errors using the extension traits or directly push them.
#[must_use]
#[derive(Debug, Default)]
pub struct ConfigParsingError(Vec<(ConfigPath, Report)>);

impl ConfigParsingError {
    /// Add a new error to the list.
    pub fn push(&mut self, conf_path: ConfigPath, report: Report) {
        self.0.push((conf_path, report));
    }

    /// Merge all the individual errors from two `ConfigParsingErrors`.
    pub fn merge(&mut self, other: Self) {
        self.0.extend(other.0);
    }

    /// Convert this error into a result, returning `Ok(())` if there are no
    /// errors.
    pub fn into_result<T>(self, val: T) -> ConfigResult<T> {
        if self.is_ok() {
            Ok(val)
        } else {
            Err(self)
        }
    }

    /// Checks if there are no errors.
    pub fn is_ok(&self) -> bool {
        self.0.is_empty()
    }
}

impl FromIterator<ConfigParsingError> for ConfigParsingError {
    fn from_iter<T: IntoIterator<Item = ConfigParsingError>>(iter: T) -> Self {
        Self(iter.into_iter().flat_map(|e| e.0).collect())
    }
}

impl Display for ConfigParsingError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "ParsingError")?;
        for (path, report) in &self.0 {
            writeln!(f, "\n#####\n")?;
            writeln!(f, "config_path: `{path}`")?;
            writeln!(f, "env_path: `{}`", path.env_name())?;
            writeln!(f, "arg_key: `{}`", path.arg_name())?;
            writeln!(f, "error: {report:?}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigParsingError {}

/// Try to unwrap a series of options during config parsing and handle errors more gracefully than
/// unwrapping and causing a panic if we forgot to assert something earlier.
///
/// Use as `cfg_unwrap_all!(cwp, err: [a, b, c])` where `cwp` is the current working path and `err`
/// is the `ConfigParsingError`, and a, b, and c are the options to unwrap. The result will be that
/// calling this macro a, b, and c will be unwrapped and assigned to variables of the same name.
#[macro_export]
macro_rules! cfg_unwrap_all {
    ($cwp:expr, $err:ident: [$($i:ident),+$(,)?]) => {
        $(cfg_unwrap_all!(@unwrap $cwp, $err, $i);)*
    };
    (@unwrap $cwp:expr, $err:ident, $i:ident) => {
        let $i = if let Some($i) = $i {
            $i
        } else {
            if $err.is_ok() {
                // This should never happen if we write our code correctly
                tracing::warn!(
                    ident=stringify!($i),
                    config_path=%$cwp,
                    "Invalid configuration; seeing this error means we forgot to handle a specific error case before unwrapping it."
                );
                $err.push($cwp.clone(), eyre::eyre!(
                    "Invalid configuration; seeing this error means we forgot to handle a specific error case before unwrapping it. Occurred when accessing ({})",
                    stringify!($i)
                ));
            }
            return Err($err);
        };
    };
}
