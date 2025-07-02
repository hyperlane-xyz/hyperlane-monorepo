use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain};

pub fn kas_domains() -> Vec<HyperlaneDomain> {
    vec![
        HyperlaneDomain::Known(KnownHyperlaneDomain::Kaspa),
        HyperlaneDomain::Known(KnownHyperlaneDomain::KaspaTest10),
        HyperlaneDomain::Known(KnownHyperlaneDomain::KaspaLocal),
    ]
}

/// is it a kaspa domain?
pub fn is_kas(d: &HyperlaneDomain) -> bool {
    match d {
        HyperlaneDomain::Known(domain) => matches!(
            domain,
            KnownHyperlaneDomain::Kaspa
                | KnownHyperlaneDomain::KaspaTest10
                | KnownHyperlaneDomain::KaspaLocal
        ),
        HyperlaneDomain::Unknown { .. } => false,
    }
}
