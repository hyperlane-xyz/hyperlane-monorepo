use std::fmt::{Debug, Formatter};
use std::num::{ParseIntError, TryFromIntError};
use std::str::FromStr;

use serde::Deserialize;
use sha3::{digest::Update, Digest, Keccak256};
use thiserror::Error;

use crate::{KnownHyperlaneDomain, H256};

/// Strips the '0x' prefix off of hex string so it can be deserialized.
///
/// # Arguments
///
/// * `s` - The hex str
pub fn strip_0x_prefix(s: &str) -> &str {
    if s.len() < 2 || &s[..2] != "0x" {
        s
    } else {
        &s[2..]
    }
}

/// Computes hash of domain concatenated with "HYPERLANE"
pub fn domain_hash(address: H256, domain: impl Into<u32>) -> H256 {
    H256::from_slice(
        Keccak256::new()
            .chain(domain.into().to_be_bytes())
            .chain(address)
            .chain("HYPERLANE")
            .finalize()
            .as_slice(),
    )
}

/// Computes hash of domain concatenated with "HYPERLANE_ANNOUNCEMENT"
pub fn announcement_domain_hash(address: H256, domain: impl Into<u32>) -> H256 {
    H256::from_slice(
        Keccak256::new()
            .chain(domain.into().to_be_bytes())
            .chain(address)
            .chain("HYPERLANE_ANNOUNCEMENT")
            .finalize()
            .as_slice(),
    )
}

/// A Hex String of length `N` representing bytes of length `N / 2`
#[derive(Debug, Clone)]
pub struct HexString<const N: usize>(String);

/// An hex string parsing error
#[derive(Error, Debug)]
pub enum HexStringError {
    /// String was expected to be of a different length
    #[error("Expected string of length {expected}, got {actual}")]
    InvalidStringLength {
        /// expected string length
        expected: usize,
        /// actual string length
        actual: usize,
    },
    /// Provided string was not hex
    #[error("The provided string is not hex: {0:?}")]
    NotHex(String),
}

impl<const N: usize> AsRef<str> for HexString<N> {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl<const N: usize> HexString<N> {
    /// Instantiate a new HexString from any `AsRef<str>`. Tolerates 0x
    /// prefixing. A succesful instantiation will create an owned copy of the
    /// string.
    pub fn from_string<S: AsRef<str>>(candidate: S) -> Result<Self, HexStringError> {
        let s = strip_0x_prefix(candidate.as_ref());

        if s.len() != N {
            return Err(HexStringError::InvalidStringLength {
                actual: s.len(),
                expected: N,
            });
        }

        // Lazy. Should do the check as a cheaper action
        #[allow(clippy::question_mark)]
        if hex::decode(s).is_err() {
            return Err(HexStringError::NotHex(s.to_owned()));
        }
        Ok(Self(s.to_owned()))
    }
}

impl<const N: usize> FromStr for HexString<N> {
    type Err = HexStringError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_string(s)
    }
}

impl<'de, const N: usize> serde::Deserialize<'de> for HexString<N> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Self::from_string(s).map_err(serde::de::Error::custom)
    }
}

/// Pretty print an address based on the domain it is for.
pub fn fmt_address_for_domain(domain: u32, addr: H256) -> String {
    KnownHyperlaneDomain::try_from(domain)
        .map(|d| d.domain_protocol().fmt_address(addr))
        .unwrap_or_else(|_| format!("{addr:?}"))
}

/// Pretty print a byte slice for logging
pub fn fmt_bytes(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Format a domain id as a name if it is known or just the number if not.
pub fn fmt_domain(domain: u32) -> String {
    KnownHyperlaneDomain::try_from(domain)
        .map(|d| d.to_string())
        .unwrap_or_else(|_| domain.to_string())
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

/// Shortcut for many-to-one match statements that get very redundant. Flips the
/// order such that the thing which is mapped to is listed first.
///
/// ```ignore
/// match v {
///   V1 => A,
///   V2 => A,
///   V3 => B,
///   V4 => B,
/// }
///
/// // becomes
///
/// many_to_one!(match v {
///     A: [V1, V2],
///     B: [v3, V4],
/// })
/// ```
macro_rules! many_to_one {
    (match $v:ident {
        $($result:path: [$($source:path),*$(,)?]),*$(,)?
    }) => {
        match $v {
            $($( $source => $result, )*)*
        }
    }
}

pub(crate) use many_to_one;
