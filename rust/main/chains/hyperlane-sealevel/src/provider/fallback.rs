use std::{fmt::Debug, ops::Deref};

use super::SealevelProvider;

use derive_new::new;
use hyperlane_core::{rpc_clients::FallbackProvider, HyperlaneChain};

/// Fallback provider for sealevel
#[derive(Clone, new)]
pub struct SealevelFallbackProvider {
    fallback_provider: FallbackProvider<SealevelProvider, SealevelProvider>,
}

impl Debug for SealevelFallbackProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "SealevelFallbackProvider {{ count: {} }}",
            self.fallback_provider.len()
        )
    }
}

impl Deref for SealevelFallbackProvider {
    type Target = FallbackProvider<SealevelProvider, SealevelProvider>;

    fn deref(&self) -> &Self::Target {
        &self.fallback_provider
    }
}

impl HyperlaneChain for SealevelFallbackProvider {
    fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
        &self.fallback_provider.inner.providers[0].domain
    }
    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        &self.fallback_provider.inner.providers[0]
    }
}
