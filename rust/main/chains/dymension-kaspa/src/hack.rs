use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, HyperlaneLogStore, HyperlaneMessage};

use dym_kas_core::query::deposits::get_deposits;

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

// https://github.com/dymensionxyz/hyperlane-monorepo/blob/20b9e669afcfb7728e66b5932e85c0f7fcbd50c1/dymension/libs/kaspa/lib/relayer/note.md#L102-L119
pub async fn run_monitor<T: HyperlaneLogStore<HyperlaneMessage>>(store: &T) {
    get_deposits();
}
