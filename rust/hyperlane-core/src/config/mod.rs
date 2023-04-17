//! A set of traits and types to make configuration parsing easier. The main
//! flow is to define a config struct and then a raw config struct which mirrors
//! it but is more forgiving for the deserialization, and then to implement
//! `FromRawConf` which will allow for better error messages.

use std::fmt::{Debug, Display, Formatter};

use eyre::Report;
use pico_args::Arguments;
use serde::Deserialize;

pub use config_path::ConfigPath;
pub use str_or_int::{StrOrInt, StrOrIntParseError};
pub use trait_ext::*;

mod config_path;
mod str_or_int;
mod trait_ext;

/// A result type that is used for config parsing and may contain multiple
/// errors.
pub type ConfigResult<T> = Result<T, ConfigParsingError>;

/// A trait that allows for constructing `Self` from a raw config type.
pub trait FromRawConf<'de, T, F = ()>: Sized
where
    // technically we don't need this bound but it enforces
    // the correct usage.
    T: Debug + Deserialize<'de>,
    F: Default,
{
    /// Construct `Self` from a raw config type.
    /// - `raw` is the raw config value
    /// - `cwp` is the current working path
    /// - `cla` are the command line arguments that can be read as needed
    fn from_config(raw: T, cwp: &ConfigPath, cla: &mut Arguments) -> ConfigResult<Self> {
        Self::from_config_filtered(raw, cwp, F::default(), cla)
    }

    /// Construct `Self` from a raw config type with a filter to limit what
    /// config paths are used.
    /// - `raw` is the raw config value
    /// - `cwp` is the current working path
    /// - `filter` can define what config paths are parsed
    /// - `cla` are the command line arguments that can be read as needed
    fn from_config_filtered(
        raw: T,
        cwp: &ConfigPath,
        filter: F,
        cla: &mut Arguments,
    ) -> ConfigResult<Self>;
}

/// A trait that allows for converting a raw config type into a "parsed" type.
pub trait IntoParsedConf<'de, F: Default>: Debug + Deserialize<'de> {
    /// Parse the config with a filter to limit what config paths are used.
    fn parse_config_with_filter<O: FromRawConf<'de, Self, F>>(
        self,
        cwp: &ConfigPath,
        filter: F,
        cla: &mut Arguments,
    ) -> ConfigResult<O>;

    /// Parse the config.
    fn parse_config<O: FromRawConf<'de, Self, F>>(
        self,
        cwp: &ConfigPath,
        cla: &mut Arguments,
    ) -> ConfigResult<O> {
        self.parse_config_with_filter(cwp, F::default(), cla)
    }
}

impl<'de, S, F> IntoParsedConf<'de, F> for S
where
    S: Deserialize<'de> + Debug,
    F: Default,
{
    fn parse_config_with_filter<O: FromRawConf<'de, S, F>>(
        self,
        cwp: &ConfigPath,
        filter: F,
        cla: &mut Arguments,
    ) -> ConfigResult<O> {
        O::from_config_filtered(self, cwp, filter, cla)
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
    pub fn into_result(self) -> ConfigResult<()> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(self)
        }
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
            writeln!(f, "error: {report:?}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigParsingError {}
