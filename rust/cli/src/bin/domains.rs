//! List all known Hyperlane domains.

#![forbid(unsafe_code)]

use hyperlane_core::KnownHyperlaneDomain;
use itertools::Itertools;
use strum::IntoEnumIterator;

// Potentially move this to an hl command?
fn main() {
    println!("Known Hyperlane domains:");

    for domain in KnownHyperlaneDomain::iter().sorted() {
        println!(
            "{:>12}: {:<24} ({:?} {:?})",
            domain as u32,
            format!("{domain:?}"),
            domain.domain_protocol(),
            domain.domain_type(),
        );
    }
}
