use std::sync::Arc;

use url::Url;

use hyperlane_core::HyperlaneDomain;
use hyperlane_metric::prometheus_metric::{ChainInfo, PrometheusClientMetrics};

use crate::fallback::SealevelFallbackRpcClient;
use crate::tx_submitter::TransactionSubmitter;
use crate::{ConnectionConf, SealevelProvider};

use super::{JitoTransactionSubmitter, RpcTransactionSubmitter};

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
        provider: &Arc<SealevelProvider>,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
        domain: HyperlaneDomain,
        conf: &ConnectionConf,
    ) -> Box<dyn TransactionSubmitter> {
        match self {
            // if we don't have urls set for tx submitter, use
            // the urls already being used by SealevelFallbackProvider
            TransactionSubmitterConfig::Rpc { urls } if urls.is_empty() => {
                Box::new(RpcTransactionSubmitter::new(provider.clone()))
            }
            // if we have urls set for tx submitter, create
            // a new SealevelFallbackProvider just for tx submitter
            TransactionSubmitterConfig::Rpc { urls } => {
                let urls: Vec<_> = urls.iter().filter_map(|url| Url::parse(url).ok()).collect();

                let rpc_client = SealevelFallbackRpcClient::from_urls(chain, urls, metrics);
                let provider = SealevelProvider::new(rpc_client, domain, &[], conf);
                Box::new(RpcTransactionSubmitter::new(Arc::new(provider)))
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

                let rpc_client = SealevelFallbackRpcClient::from_urls(chain, urls, metrics);
                let submit_provider = SealevelProvider::new(rpc_client, domain, &[], conf);
                Box::new(JitoTransactionSubmitter::new(
                    provider.clone(),
                    Arc::new(submit_provider),
                ))
            }
        }
    }
}
