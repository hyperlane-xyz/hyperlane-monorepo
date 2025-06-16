use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, HyperlaneLogStore, HyperlaneMessage};

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

pub async fn run_monitor<T: HyperlaneLogStore<HyperlaneMessage>>(store: &T) {
    
}
