//! A set of traits and types to make configuration parsing easier. The main
//! flow is to define a config struct and then a raw config struct which mirrors
//! it but is more forgiving for the deserialization, and then to implement
//! `FromRawConf` which will allow for better error messages.

// TODO: Remove extension functions we are not using

use convert_case::{Case, Casing};
use std::fmt::{Debug, Display, Formatter};
use std::num::{ParseIntError, TryFromIntError};
use std::ops::Add;
use std::sync::Arc;

use eyre::{eyre, Report};
use itertools::Itertools;
use primitive_types::U256;
use serde::Deserialize;
use thiserror::Error;

pub trait ConfigOptionExt<T> {
    fn expect_or_eyre<M: Into<String>>(self, msg: M) -> eyre::Result<T>;

    fn expect_or_else_eyre<F>(self, f: F) -> eyre::Result<T>
    where
        F: FnOnce() -> Report;

    fn expect_or_config_err<F>(self, v: F) -> ConfigResult<T>
    where
        F: FnOnce() -> (ConfigPath, Report);
}

impl<T> ConfigOptionExt<T> for Option<T> {
    fn expect_or_eyre<M: Into<String>>(self, msg: M) -> eyre::Result<T> {
        self.ok_or_else(|| eyre!(msg.into()))
    }

    fn expect_or_else_eyre<F>(self, f: F) -> eyre::Result<T>
    where
        F: FnOnce() -> Report,
    {
        self.ok_or_else(|| f())
    }

    fn expect_or_config_err<F>(self, v: F) -> ConfigResult<T>
    where
        F: FnOnce() -> (ConfigPath, Report),
    {
        self.ok_or_else(|| {
            let (path, msg) = v();
            ConfigParsingError::new(path, msg)
        })
    }
}

pub trait ConfigErrResultExt<T> {
    fn into_config_result(self, path: impl FnOnce() -> ConfigPath) -> ConfigResult<T>;

    fn take_err(self, err: &mut ConfigParsingError, path: impl FnOnce() -> ConfigPath)
        -> Option<T>;
}

impl<T, E> ConfigErrResultExt<T> for Result<T, E>
where
    E: Into<Report>,
{
    fn into_config_result(self, path: impl FnOnce() -> ConfigPath) -> ConfigResult<T> {
        self.map_err(|e| ConfigParsingError::new(path(), e.into()))
    }

    fn take_err(
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
}

pub trait ConfigResultExt<T> {
    fn take_config_err(self, err: &mut ConfigParsingError) -> Option<T>;
}

impl<T> ConfigResultExt<T> for ConfigResult<T> {
    fn take_config_err(self, err: &mut ConfigParsingError) -> Option<T> {
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
pub struct ConfigPath(Vec<Arc<String>>);

impl Display for ConfigPath {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.path_name())
    }
}

impl<S: Into<String>> Add<S> for &ConfigPath {
    type Output = ConfigPath;

    fn add(self, rhs: S) -> Self::Output {
        self.join(rhs)
    }
}

impl Add<ConfigPath> for &ConfigPath {
    type Output = ConfigPath;

    fn add(self, rhs: ConfigPath) -> Self::Output {
        self.merge(&rhs)
    }
}

impl ConfigPath {
    pub fn join(&self, part: impl Into<String>) -> Self {
        let part = part.into();
        debug_assert!(!part.contains('.'));
        let mut new = self.clone();
        new.0.push(Arc::new(part));
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
            .map(|s| s.to_case(Case::ScreamingSnake))
            .join("_")
    }
}

#[test]
fn env_casing() {
    assert_eq!(
        "HYP_BASE_TEST1_CONF",
        "hyp base test1 conf".to_case(Case::ScreamingSnake)
    );
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
        writeln!(f, "ParsingError")?;
        for (path, report) in &self.0 {
            writeln!(f, "\n#####\n")?;
            writeln!(f, "config_path: `{path}`")?;
            // TODO: enable this once we figure out how to do it correctly
            // writeln!(f, "env_path: `{}`", path.env_name())?;
            writeln!(f, "error: {report:?}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigParsingError {}

pub trait FromRawConf<'de, T>: Sized
where
    // technically we don't need this bound but it enforces the
    // correct usage.
    T: Debug + Deserialize<'de>,
{
    fn from_config(raw: T, cwp: &ConfigPath) -> ConfigResult<Self>;
}

pub trait IntoParsedConf<'de, O: Sized>: Debug + Deserialize<'de> {
    fn parse_config(self, cwp: &ConfigPath) -> ConfigResult<O>;
}

impl<'de, S, O> IntoParsedConf<'de, O> for S
where
    S: Deserialize<'de> + Debug,
    O: FromRawConf<'de, S>,
{
    fn parse_config(self, cwp: &ConfigPath) -> ConfigResult<O> {
        O::from_config(self, cwp)
    }
}

/// An error when parsing a StrOrInt type as an integer value.
#[derive(Error, Debug)]
pub enum StrOrIntParseError {
    /// The string is not a valid integer
    #[error("Invalid integer provided as a string: {0}")]
    StrParse(#[from] ParseIntError),
    /// The provided integer does not match the type requirements.
    #[error("Provided number is an invalid integer: {0}")]
    InvalidInt(#[from] TryFromIntError),
    #[error("Could not parse integer: {0}")]
    Other(String),
}

/// A type which can be used for parsing configs that may be provided as a
/// string or an integer but will ultimately be read as an integer. E.g. where
/// `"domain": "42"` and `"domain": 42` should both be considered valid.
#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum StrOrInt {
    /// The parsed type is a string
    Str(String),
    /// The parsed type is an integer
    Int(i64),
}

impl Debug for StrOrInt {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            StrOrInt::Str(v) => write!(f, "\"{v}\""),
            StrOrInt::Int(v) => write!(f, "{}", *v),
        }
    }
}

impl From<i64> for StrOrInt {
    fn from(value: i64) -> Self {
        StrOrInt::Int(value)
    }
}

impl From<String> for StrOrInt {
    fn from(value: String) -> Self {
        StrOrInt::Str(value)
    }
}

impl From<&str> for StrOrInt {
    fn from(value: &str) -> Self {
        StrOrInt::Str(value.to_owned())
    }
}

macro_rules! convert_to {
    ($t:ty) => {
        impl TryFrom<StrOrInt> for $t {
            type Error = StrOrIntParseError;

            fn try_from(v: StrOrInt) -> Result<Self, Self::Error> {
                (&v).try_into()
            }
        }

        impl TryFrom<&StrOrInt> for $t {
            type Error = StrOrIntParseError;

            fn try_from(v: &StrOrInt) -> Result<Self, Self::Error> {
                Ok(match v {
                    StrOrInt::Str(s) => s.parse()?,
                    StrOrInt::Int(i) => (*i).try_into()?,
                })
            }
        }
    };
}

convert_to!(u16);
convert_to!(u32);
convert_to!(u64);

impl TryFrom<StrOrInt> for U256 {
    type Error = StrOrIntParseError;

    fn try_from(v: StrOrInt) -> Result<Self, Self::Error> {
        (&v).try_into()
    }
}

impl TryFrom<&StrOrInt> for U256 {
    type Error = StrOrIntParseError;

    fn try_from(v: &StrOrInt) -> Result<Self, Self::Error> {
        Ok(match v {
            StrOrInt::Str(s) => s.parse().map_err(|_| {
                StrOrIntParseError::Other(format!("Unable to parse U256 string ({s})"))
            })?,
            StrOrInt::Int(i) => (*i).try_into().map_err(|_| {
                StrOrIntParseError::Other(format!("Unable to parse integer as U256 ({i})"))
            })?,
        })
    }
}
