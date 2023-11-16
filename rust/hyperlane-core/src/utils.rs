use std::{str::FromStr, time::Duration};

use eyre::Result;
use sha3::{digest::Update, Digest, Keccak256};

use crate::{KnownHyperlaneDomain, H160, H256};

/// Converts a hex or base58 string to an H256.
pub fn hex_or_base58_to_h256(string: &str) -> Result<H256> {
    let h256 = if string.starts_with("0x") {
        match string.len() {
            66 => H256::from_str(string)?,
            42 => H160::from_str(string)?.into(),
            _ => eyre::bail!("Invalid hex string"),
        }
    } else {
        let bytes = bs58::decode(string).into_vec()?;
        if bytes.len() != 32 {
            eyre::bail!("Invalid length of base58 string")
        }
        H256::from_slice(bytes.as_slice())
    };

    Ok(h256)
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
    #[cfg(feature = "strum")]
    {
        KnownHyperlaneDomain::try_from(domain)
            .map(|d| d.to_string())
            .unwrap_or_else(|_| domain.to_string())
    }
    #[cfg(not(feature = "strum"))]
    {
        domain.to_string()
    }
}

/// Formats the duration in the most appropriate time units.
#[cfg(feature = "float")]
pub fn fmt_duration(dur: Duration) -> String {
    const MIN: f64 = 60.;
    const HOUR: f64 = MIN * 60.;
    const DAY: f64 = HOUR * 24.;
    const YEAR: f64 = DAY * 365.25;

    let sec = dur.as_secs_f64();
    if sec < 60. {
        format!("{:.0}s", sec)
    } else if sec < HOUR {
        format!("{:.1}m", sec / MIN)
    } else if sec < DAY {
        format!("{:.2}h", sec / HOUR)
    } else if sec < YEAR {
        format!("{:.2}d", sec / DAY)
    } else {
        format!("{:.2}y", sec / YEAR)
    }
}

/// Formats the duration in the most appropriate time units and says "synced" if
/// the duration is 0.
#[cfg(feature = "float")]
pub fn fmt_sync_time(dur: Duration) -> String {
    if dur.as_secs() == 0 {
        "synced".into()
    } else {
        fmt_duration(dur)
    }
}

/// Use as `#[serde(with = serde_u128)]` to serialize/deserialize u128s as strings but not break
/// support for numbers.
pub mod serde_u128 {
    use serde::{de, de::Visitor, Deserializer, Serializer};

    struct U128Visitor;

    impl Visitor<'_> for U128Visitor {
        type Value = u128;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string or number representing a u128")
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            v.parse::<u128>()
                .map_err(|_| E::custom("failed to parse u128"))
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(v as u128)
        }

        fn visit_u128<E: de::Error>(self, v: u128) -> Result<Self::Value, E> {
            Ok(v)
        }
    }

    /// Serialize a u128 as a string.
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    /// Deserialize a u128 that might be a string or a number.
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        d.deserialize_any(U128Visitor)
    }

    #[cfg(test)]
    mod test {
        #[derive(Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
        struct Test {
            #[serde(with = "super")]
            v: u128,
        }

        #[test]
        fn test_serialize() {
            assert_eq!(
                serde_json::to_string(&Test { v: 0 }).unwrap(),
                r#"{"v":"0"}"#
            );
            assert_eq!(
                serde_json::to_string(&Test { v: 42 }).unwrap(),
                r#"{"v":"42"}"#
            );
            assert_eq!(
                serde_json::to_string(&Test { v: u128::MAX }).unwrap(),
                format!(r#"{{"v":"{}"}}"#, u128::MAX)
            );
        }

        #[test]
        fn test_deserialize_str() {
            assert_eq!(
                serde_json::from_str::<Test>(r#"{"v":"0"}"#).unwrap(),
                Test { v: 0 }
            );
            assert_eq!(
                serde_json::from_str::<Test>(r#"{"v":"42"}"#).unwrap(),
                Test { v: 42 }
            );
            assert_eq!(
                serde_json::from_str::<Test>(&format!(r#"{{"v":"{}"}}"#, u128::MAX)).unwrap(),
                Test { v: u128::MAX }
            )
        }

        #[test]
        fn test_deserialize_int() {
            assert_eq!(
                serde_json::from_str::<Test>(r#"{"v":0}"#).unwrap(),
                Test { v: 0 }
            );
            assert_eq!(
                serde_json::from_str::<Test>(r#"{"v":42}"#).unwrap(),
                Test { v: 42 }
            );
        }
    }
}

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

/// Unwrap an expression that returns an `Option`, and return `Ok(None)` if it is `None`.
/// Otherwise, assign the value to the given variable name.
/// We use the pattern of returning `Ok(None)` a lot because of our retry logic,
/// and the goal of this macro is to reduce the boilerplate.
/// ```ignore
/// // before using the macro:
/// let Some(idx) = self.index_of_next_key()
/// else {
///     return Ok(None);
/// };
/// // after:
/// unwrap_or_none_result!(idx, self.index_of_next_key());
/// ```
#[macro_export]
macro_rules! unwrap_or_none_result {
    ($variable_name:ident, $e:expr $(, $else_e:expr)?) => {
        let Some($variable_name) = $e
        else {
            $($else_e;)?
            return Ok(None);
        };
    };
}

pub(crate) use many_to_one;
