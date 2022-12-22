use std::str::FromStr;

use sha3::{Digest, Keccak256};
use thiserror::Error;

use crate::H256;

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
            .chain(address.as_ref())
            .chain("HYPERLANE".as_bytes())
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
        Self::from_string(&s).map_err(serde::de::Error::custom)
    }
}
