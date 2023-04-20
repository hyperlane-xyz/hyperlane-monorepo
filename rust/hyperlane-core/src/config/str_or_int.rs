use primitive_types::U256;
use serde::Deserialize;
use std::fmt::{Debug, Formatter};
use std::num::{ParseIntError, TryFromIntError};
use thiserror::Error;

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

/// An error when parsing a StrOrInt type as an integer value.
#[derive(Error, Debug)]
pub enum StrOrIntParseError {
    /// The string is not a valid integer
    #[error("Invalid integer provided as a string: {0}")]
    StrParse(#[from] ParseIntError),
    /// The provided integer does not match the type requirements.
    #[error("Provided number is an invalid integer: {0}")]
    InvalidInt(#[from] TryFromIntError),
    /// Some other error occured.
    #[error("Could not parse integer: {0}")]
    Other(String),
}
