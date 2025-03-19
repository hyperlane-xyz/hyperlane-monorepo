use std::sync::Arc;

use hyperlane_core::{rpc_clients::FallbackProvider, HyperlaneDomain};
use hyperlane_metric::prometheus_metric::{ChainInfo, PrometheusClientMetrics};
use url::Url;

use crate::{
    client_builder::SealevelRpcClientBuilder, fallback::SealevelFallbackProvider,
    tx_submitter::TransactionSubmitter, ConnectionConf, SealevelProvider,
};

/// Configuration for the transaction submitter
#[derive(Debug, Clone)]
pub enum TransactionSubmitterConfig {
    /// Use the RPC transaction submitter
    Rpc {
        /// The URL to use. If not provided, a default RPC URL will be used
        urls: Vec<String>,
    },
    /// Use the Jito transaction submitter
    Jito {
        /// The URL to use. If not provided, a default Jito URL will be used
        urls: Vec<String>,
    },
}

impl Default for TransactionSubmitterConfig {
    fn default() -> Self {
        TransactionSubmitterConfig::Rpc { urls: Vec::new() }
    }
}

impl TransactionSubmitterConfig {
    /// Create a new transaction submitter from the configuration
    pub fn create_submitter(
        &self,
        provider: &Arc<SealevelFallbackProvider>,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
        domain: HyperlaneDomain,
        conf: &ConnectionConf,
    ) -> TransactionSubmitter {
        match self {
            TransactionSubmitterConfig::Rpc { urls } if urls.is_empty() => {
                TransactionSubmitter::new(self.clone(), provider.clone())
            }
            TransactionSubmitterConfig::Rpc { urls } => {
                let providers: Vec<_> = urls
                    .iter()
                    .filter_map(|url| Url::parse(url).ok())
                    .map(|rpc_url| {
                        SealevelRpcClientBuilder::new(rpc_url)
                            .with_prometheus_metrics(metrics.clone(), chain.clone())
                            .build()
                    })
                    .map(|rpc_client| {
                        SealevelProvider::new(Arc::new(rpc_client), domain.clone(), &[], conf)
                    })
                    .collect();
                let fallback = FallbackProvider::new(providers);
                let provider = Arc::new(SealevelFallbackProvider::new(fallback));
                TransactionSubmitter::new(self.clone(), provider)
            }
            TransactionSubmitterConfig::Jito { urls } => {
                // Default to a bundle-only URL (i.e. revert protected)
                let urls = if urls.is_empty() {
                    &[
                        "https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true"
                            .to_string(),
                    ]
                } else {
                    urls.as_slice()
                };
                let providers: Vec<_> = urls
                    .iter()
                    .filter_map(|url| Url::parse(url).ok())
                    .map(|rpc_url| {
                        SealevelRpcClientBuilder::new(rpc_url.clone())
                            .with_prometheus_metrics(metrics.clone(), chain.clone())
                            .build()
                    })
                    .map(|rpc_client| {
                        SealevelProvider::new(Arc::new(rpc_client), domain.clone(), &[], conf)
                    })
                    .collect();
                let fallback = FallbackProvider::new(providers);
                let provider = Arc::new(SealevelFallbackProvider::new(fallback));
                TransactionSubmitter::new(self.clone(), provider)
            }
        }
    }
}
