use std::str::FromStr;

use hyperlane_core::KnownHyperlaneDomain;
use strum::IntoEnumIterator;

pub fn show_domains() {
    println!("\n\nAvailable hyperlane domains:");
    for domain in KnownHyperlaneDomain::iter() {
        println!(
            "{}: [ID = {}]",
            domain.as_str().to_lowercase(),
            domain as u32
        );
    }
}

pub fn validate_domain(s: &str) -> Result<KnownHyperlaneDomain, String> {
    show_domains();
    KnownHyperlaneDomain::from_str(s).map_err(|_| format!("{s} is an invalid domain"))
}
