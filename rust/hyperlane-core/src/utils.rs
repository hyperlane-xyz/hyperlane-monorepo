use std::str::FromStr;

use eyre::{bail, Report};
use sha3::{Digest, Keccak256};

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
pub fn domain_hash(address: H256, domain: u32) -> H256 {
    H256::from_slice(
        Keccak256::new()
            .chain(domain.to_be_bytes())
            .chain(address.as_ref())
            .chain("HYPERLANE".as_bytes())
            .finalize()
            .as_slice(),
    )
}

/// A Hex String of length `N` representing bytes of length `N / 2`
#[derive(Debug, Clone)]
pub struct HexString<const N: usize>(String);

impl<const N: usize> AsRef<String> for HexString<N> {
    fn as_ref(&self) -> &String {
        &self.0
    }
}

impl<const N: usize> HexString<N> {
    /// Instantiate a new HexString from any `AsRef<str>`. Tolerates 0x
    /// prefixing. A succesful instantiation will create an owned copy of the
    /// string.
    pub fn from_string<S: AsRef<str>>(candidate: S) -> Result<Self, Report> {
        let s = strip_0x_prefix(candidate.as_ref());

        if s.len() != N {
            bail!("Expected string of length {}, got {}", N, s.len());
        }

        // Lazy. Should do the check as a cheaper action
        #[allow(clippy::question_mark)]
        if hex::decode(s).is_err() {
            bail!("String is not hex");
        }
        Ok(Self(s.to_owned()))
    }
}

impl<const N: usize> FromStr for HexString<N> {
    type Err = Report;

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
