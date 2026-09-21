//! Shared endpoint isolation for checkpoint verification and reorg diagnostics.
use eyre::{eyre, Result};
use futures_util::future::try_join_all;
use hyperlane_base::{
    settings::{ChainConf, ChainConnectionConf},
    CoreMetrics,
};
use hyperlane_core::{ChainResult, MerkleTreeHook};
use hyperlane_ethereum::RpcConnectionConf;
use hyperlane_metric::prometheus_metric::RpcRole;
use std::{collections::HashSet, sync::Arc};
use tracing::warn;
use url::Url;

/// Removes exact duplicate URLs (order-preserving). A duplicated endpoint would
/// otherwise count as two independent votes, undermining the quorum's independence
/// assumption.
pub(crate) fn dedupe_rpc_urls(urls: Vec<Url>, source: &'static str) -> Vec<Url> {
    let original_count = urls.len();
    let mut seen = HashSet::new();
    let deduped: Vec<Url> = urls
        .into_iter()
        .filter(|url| seen.insert(url.clone()))
        .collect();
    if deduped.len() < original_count {
        warn!(
            source,
            original_count,
            deduped_count = deduped.len(),
            "RPC configuration contained duplicate entries; deduping to preserve vote independence"
        );
    }
    deduped
}

/// Select the protocol's actual state-read transport. Splitting Cosmos RPC
/// URLs or Tron JSON-RPC URLs would leave root reads on a shared fallback pool.
pub(crate) fn state_read_urls(
    chain: &ChainConf,
    rpc_urls: Vec<Url>,
) -> Result<(&'static str, Vec<Url>)> {
    Ok(match &chain.connection {
        ChainConnectionConf::Ethereum(_) => ("rpcUrls", rpc_urls),
        ChainConnectionConf::Sealevel(conn) => ("rpcUrls", conn.urls.clone()),
        ChainConnectionConf::Starknet(conn) => ("rpcUrls", conn.urls.clone()),
        ChainConnectionConf::Cosmos(conn) | ChainConnectionConf::CosmosNative(conn) => {
            ("grpcUrls", conn.grpc_urls.clone())
        }
        ChainConnectionConf::Tron(conn) => {
            ("walletSolidityUrls", conn.wallet_solidity_urls.clone())
        }
        ChainConnectionConf::Radix(conn) => ("rpcUrls", conn.core.clone()),
        #[cfg(feature = "aleo")]
        ChainConnectionConf::Aleo(conn) => ("rpcUrls", conn.rpcs.clone()),
        ChainConnectionConf::Fuel(_) => {
            return Err(eyre!("Fuel does not support validator Merkle tree hooks"))
        }
    })
}

pub(crate) fn chain_conf_for_read_url(
    origin_chain_conf: &ChainConf,
    url: Url,
    role: RpcRole,
) -> ChainConf {
    let mut chain_conf = origin_chain_conf.clone();
    match &mut chain_conf.connection {
        ChainConnectionConf::Ethereum(conn) => {
            conn.rpc_connection = if matches!(url.scheme(), "ws" | "wss") {
                RpcConnectionConf::Ws { url }
            } else {
                RpcConnectionConf::Http { url }
            };
        }
        ChainConnectionConf::Sealevel(conn) => conn.urls = vec![url],
        ChainConnectionConf::Starknet(conn) => conn.urls = vec![url],
        ChainConnectionConf::Cosmos(conn) | ChainConnectionConf::CosmosNative(conn) => {
            conn.grpc_urls = vec![url]
        }
        ChainConnectionConf::Tron(conn) => conn.wallet_solidity_urls = vec![url],
        ChainConnectionConf::Radix(conn) => conn.core = vec![url],
        #[cfg(feature = "aleo")]
        ChainConnectionConf::Aleo(conn) => conn.rpcs = vec![url],
        ChainConnectionConf::Fuel(_) => {
            unreachable!("Fuel rejected when selecting read endpoints")
        }
    }
    chain_conf.metrics_conf.rpc_role = role;
    chain_conf
}

/// Builds one single-URL `MerkleTreeHook` per entry in `urls`, labeled
/// `{label_prefix}[i]` (by index, never by host/URL — some entries may be private
/// RPCs, and even a redacted host can identify the provider, e.g. "alchemy.com") and
/// tagged with `role` for the underlying connection's `rpc_role` Prometheus label.
pub(crate) async fn build_validator_per_url_hooks(
    origin_chain_conf: &ChainConf,
    label_prefix: &str,
    role: RpcRole,
    urls: &[Url],
    metrics: &Arc<CoreMetrics>,
) -> ChainResult<Vec<(String, Arc<dyn MerkleTreeHook>)>> {
    let hooks = try_join_all(urls.iter().cloned().enumerate().map(|(i, url)| async move {
        if !matches!(url.scheme(), "http" | "https" | "ws" | "wss") || url.host_str().is_none() {
            return Err(hyperlane_core::ChainCommunicationError::from_other_str(
                "Invalid state-read endpoint URL",
            ));
        }
        let deferred = matches!(
            &origin_chain_conf.connection,
            ChainConnectionConf::Ethereum(_)
        ) && matches!(url.scheme(), "ws" | "wss");
        let chain = chain_conf_for_read_url(origin_chain_conf, url, role);
        let hook: Arc<dyn MerkleTreeHook> = if deferred {
            Arc::new(DeferredWsHook {
                chain,
                metrics: metrics.clone(),
                hook: tokio::sync::OnceCell::new(),
            })
        } else {
            Arc::from(chain.build_merkle_tree_hook(metrics).await?)
        };
        Ok((format!("{label_prefix}[{i}]"), hook))
    }))
    .await?;

    Ok(hooks)
}

/// Defer only the network handshake. URL/configuration validation still happens
/// when building the pool. Failed initialization is retried on the next read and
/// shares the checkpoint reader's deadline and voting slot.
struct DeferredWsHook {
    chain: ChainConf,
    metrics: Arc<CoreMetrics>,
    hook: tokio::sync::OnceCell<Box<dyn MerkleTreeHook>>,
}

impl std::fmt::Debug for DeferredWsHook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeferredWsHook").finish_non_exhaustive()
    }
}

impl DeferredWsHook {
    async fn get(&self) -> ChainResult<&dyn MerkleTreeHook> {
        self.hook
            .get_or_try_init(|| async {
                self.chain
                    .build_merkle_tree_hook(&self.metrics)
                    .await
                    .map_err(hyperlane_core::ChainCommunicationError::from)
            })
            .await
            .map(|hook| hook.as_ref())
    }
}

impl hyperlane_core::HyperlaneChain for DeferredWsHook {
    fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
        &self.chain.domain
    }
    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        self.hook
            .get()
            .expect("initialize the WebSocket hook before accessing its provider")
            .provider()
    }
}
impl hyperlane_core::HyperlaneContract for DeferredWsHook {
    fn address(&self) -> hyperlane_core::H256 {
        self.chain.addresses.merkle_tree_hook
    }
}
#[async_trait::async_trait]
impl MerkleTreeHook for DeferredWsHook {
    async fn tree(
        &self,
        period: &hyperlane_core::ReorgPeriod,
    ) -> ChainResult<hyperlane_core::IncrementalMerkleAtBlock> {
        self.get().await?.tree(period).await
    }
    async fn count(&self, period: &hyperlane_core::ReorgPeriod) -> ChainResult<u32> {
        self.get().await?.count(period).await
    }
    async fn latest_checkpoint(
        &self,
        period: &hyperlane_core::ReorgPeriod,
    ) -> ChainResult<hyperlane_core::CheckpointAtBlock> {
        self.get().await?.latest_checkpoint(period).await
    }
    async fn latest_checkpoint_at_block(
        &self,
        height: u64,
    ) -> ChainResult<hyperlane_core::CheckpointAtBlock> {
        self.get().await?.latest_checkpoint_at_block(height).await
    }
}
