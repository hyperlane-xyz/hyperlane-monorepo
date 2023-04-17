use std::time::Duration;

use sha3::{digest::Update, Digest, Keccak256};

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

/// Formats the duration in the most appropriate time units.
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
pub fn fmt_sync_time(dur: Duration) -> String {
    if dur.as_secs() == 0 {
        "synced".into()
    } else {
        fmt_duration(dur)
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

pub(crate) use many_to_one;
