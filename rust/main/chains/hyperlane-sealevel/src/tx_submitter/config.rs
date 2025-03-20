use std::sync::Arc;

use hyperlane_core::HyperlaneDomain;
use hyperlane_metric::prometheus_metric::{ChainInfo, PrometheusClientMetrics};
use url::Url;

use crate::{
    fallback::SealevelFallbackProvider, tx_submitter::TransactionSubmitter, ConnectionConf,
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
            // if we don't have urls set for tx submitter, use
            // the urls already being used by SealevelFallbackProvider
            TransactionSubmitterConfig::Rpc { urls } if urls.is_empty() => {
                TransactionSubmitter::new(self.clone(), provider.clone())
            }
            // if we have urls set for tx submitter, create
            // a new SealevelFallbackProvider just for tx submitter
            TransactionSubmitterConfig::Rpc { urls } => {
                let urls: Vec<_> = urls.iter().filter_map(|url| Url::parse(url).ok()).collect();

                let provider = Arc::new(SealevelFallbackProvider::from_urls(
                    domain,
                    conf,
                    chain,
                    &[],
                    urls,
                    metrics,
                ));
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

                let urls: Vec<_> = urls.iter().filter_map(|url| Url::parse(url).ok()).collect();

                let provider = Arc::new(SealevelFallbackProvider::from_urls(
                    domain,
                    conf,
                    chain,
                    &[],
                    urls,
                    metrics,
                ));
                TransactionSubmitter::new(self.clone(), provider)
            }
        }
    }
}
