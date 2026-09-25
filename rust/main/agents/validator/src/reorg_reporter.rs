use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::utils::keccak256;
use futures_util::future::join_all;
use serde::Serialize;
use tracing::{info, warn};
use url::Url;

use crate::rpc::{chain_conf_for_read_url, dedupe_rpc_urls, state_read_urls};
use hyperlane_base::{CheckpointSyncer, CoreMetrics};
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{CheckpointAtBlock, MerkleTreeHook, ReorgPeriod, H256};
use hyperlane_metric::prometheus_metric::RpcRole;

use crate::settings::ValidatorSettings;

#[async_trait]
pub trait ReorgReporter: Send + Sync + Debug {
    async fn report_at_block(&self, height: u64);
    async fn report_with_reorg_period(&self, reorg_period: &ReorgPeriod);
}

#[derive(Debug)]
pub struct LatestCheckpointReorgReporter {
    merkle_tree_hooks: HashMap<Url, Arc<dyn MerkleTreeHook>>,
}

#[derive(Serialize)]
struct ReorgReportRpcResponse {
    rpc_url_hash: H256,
    rpc_host_hash: H256,
    height: Option<u64>,
    reorg_period: Option<ReorgPeriod>,
    merkle_root_index: u32,
    merkle_root_hash: H256,
    timestamp: String,
}

impl ReorgReportRpcResponse {
    fn new(
        url: Url,
        latest_checkpoint: CheckpointAtBlock,
        height: Option<u64>,
        reorg_period: Option<ReorgPeriod>,
    ) -> Self {
        ReorgReportRpcResponse {
            rpc_host_hash: H256::from_slice(&keccak256(url.host_str().unwrap_or("").as_bytes())),
            rpc_url_hash: H256::from_slice(&keccak256(url.as_str().as_bytes())),
            height,
            reorg_period,
            merkle_root_hash: latest_checkpoint.checkpoint.root,
            merkle_root_index: latest_checkpoint.checkpoint.index,
            timestamp: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[async_trait]
impl ReorgReporter for LatestCheckpointReorgReporter {
    async fn report_at_block(&self, height: u64) {
        self.report_at_block(height).await;
    }

    async fn report_with_reorg_period(&self, reorg_period: &ReorgPeriod) {
        self.report_with_reorg_period(reorg_period).await;
    }
}

impl LatestCheckpointReorgReporter {
    async fn report_at_block(&self, height: u64) -> Vec<ReorgReportRpcResponse> {
        info!(?height, "Reporting latest checkpoint on reorg");
        let mut futures = vec![];
        for (url, merkle_tree_hook) in &self.merkle_tree_hooks {
            let future = async {
                let latest_checkpoint = call_and_retry_indefinitely(|| {
                    let merkle_tree_hook = merkle_tree_hook.clone();
                    Box::pin(
                        async move { merkle_tree_hook.latest_checkpoint_at_block(height).await },
                    )
                })
                .await;

                info!(rpc_url_hash = ?H256::from_slice(&keccak256(url.as_str().as_bytes())), ?height, ?latest_checkpoint, "Report latest checkpoint on reorg");
                ReorgReportRpcResponse::new(url.clone(), latest_checkpoint, Some(height), None)
            };

            futures.push(future);
        }

        join_all(futures).await
    }

    async fn report_with_reorg_period(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> Vec<ReorgReportRpcResponse> {
        info!(?reorg_period, "Reporting latest checkpoint on reorg");
        let mut futures = vec![];
        for (url, merkle_tree_hook) in &self.merkle_tree_hooks {
            let future = async {
                let latest_checkpoint = call_and_retry_indefinitely(|| {
                    let merkle_tree_hook = merkle_tree_hook.clone();
                    let period = reorg_period.clone();
                    Box::pin(async move { merkle_tree_hook.latest_checkpoint(&period).await })
                })
                .await;

                info!(rpc_url_hash = ?H256::from_slice(&keccak256(url.as_str().as_bytes())), ?reorg_period, ?latest_checkpoint, "Report latest checkpoint on reorg");
                ReorgReportRpcResponse::new(
                    url.clone(),
                    latest_checkpoint,
                    None,
                    Some(reorg_period.clone()),
                )
            };

            futures.push(future);
        }

        join_all(futures).await
    }
}

impl LatestCheckpointReorgReporter {
    pub(crate) async fn from_settings(
        settings: &ValidatorSettings,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Self> {
        let chain = settings.chain_setup(&settings.origin_chain)?;
        let rpc_urls = settings
            .rpcs
            .iter()
            .enumerate()
            .map(|(i, rpc)| {
                Url::parse(&rpc.url).map_err(|_| eyre::eyre!("Invalid rpcUrls[{i}] URL"))
            })
            .collect::<eyre::Result<Vec<_>>>()?;
        let (source, urls) = state_read_urls(chain, rpc_urls);
        let mut merkle_tree_hooks = HashMap::new();
        for url in dedupe_rpc_urls(urls, source) {
            let hook = chain_conf_for_read_url(chain, url.clone(), RpcRole::Primary)
                .build_merkle_tree_hook(metrics)
                .await?;
            merkle_tree_hooks.insert(url, Arc::from(hook));
        }
        Ok(Self { merkle_tree_hooks })
    }
}

#[derive(Debug)]
pub struct LatestCheckpointReorgReporterWithStorageWriter {
    /// `LatestCheckpointReorgReporterWithStorageWriter` is an extension to
    /// `LatestCheckpointReorgReporter`
    latest_checkpoint_reorg_reporter: LatestCheckpointReorgReporter,

    /// Currently, the storage abstraction is tied to the checkpoint syncer, which is why
    /// it is used here.
    storage_writer: Arc<dyn CheckpointSyncer>,
}

#[async_trait]
impl ReorgReporter for LatestCheckpointReorgReporterWithStorageWriter {
    async fn report_at_block(&self, height: u64) {
        let logs = self
            .latest_checkpoint_reorg_reporter
            .report_at_block(height)
            .await;
        self.submit_to_storage_writer(&logs).await;
    }

    async fn report_with_reorg_period(&self, reorg_period: &ReorgPeriod) {
        let logs = self
            .latest_checkpoint_reorg_reporter
            .report_with_reorg_period(reorg_period)
            .await;
        self.submit_to_storage_writer(&logs).await;
    }
}

impl LatestCheckpointReorgReporterWithStorageWriter {
    pub(crate) fn new(
        latest_checkpoint_reorg_reporter: LatestCheckpointReorgReporter,
        storage_writer: Arc<dyn CheckpointSyncer>,
    ) -> Self {
        Self {
            latest_checkpoint_reorg_reporter,
            storage_writer,
        }
    }

    async fn submit_to_storage_writer(&self, storage_logs_entries: &Vec<ReorgReportRpcResponse>) {
        let json_string = serde_json::to_string_pretty(storage_logs_entries).unwrap_or_else(|e| {
            warn!("Error serializing json: {}", e);
            String::from("{\"error\": \"Error formatting the string\"}")
        });
        self.storage_writer
            .write_reorg_rpc_responses(json_string)
            .await
            .unwrap_or_else(|e| {
                warn!("Error writing checkpoint syncer to reorg log: {}", e);
            });
    }
}
