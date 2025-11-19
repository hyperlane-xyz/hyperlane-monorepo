use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::utils::keccak256;
use futures_util::future::join_all;
use serde::Serialize;
use tracing::{info, warn};
use url::Url;

use hyperlane_base::settings::ChainConnectionConf;
use hyperlane_base::{CheckpointSyncer, CoreMetrics};
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{CheckpointAtBlock, HyperlaneDomain, MerkleTreeHook, ReorgPeriod, H256};
use hyperlane_ethereum::RpcConnectionConf;

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

                info!(url = ?url.clone(), ?height, ?latest_checkpoint, "Report latest checkpoint on reorg");
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

                info!(url = ?url.clone(), ?reorg_period, ?latest_checkpoint, "Report latest checkpoint on reorg");
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
        let origin = &settings.origin_chain;

        let mut merkle_tree_hooks = HashMap::new();
        for (url, settings) in Self::settings_with_single_rpc(settings, origin) {
            let chain_setup = settings.chain_setup(&settings.origin_chain)?;
            let merkle_tree_hook = chain_setup.build_merkle_tree_hook(metrics).await?;

            merkle_tree_hooks.insert(url, merkle_tree_hook.into());
        }

        let reporter = LatestCheckpointReorgReporter { merkle_tree_hooks };

        Ok(reporter)
    }

    fn settings_with_single_rpc(
        settings: &ValidatorSettings,
        origin: &HyperlaneDomain,
    ) -> Vec<(Url, ValidatorSettings)> {
        use ChainConnectionConf::{
            Aleo, Cosmos, CosmosNative, Ethereum, Fuel, Radix, Sealevel, Sovereign, Starknet,
        };

        let chain_conf = settings
            .chains
            .get(origin)
            .expect("Chain configuration is not found")
            .clone();

        let chain_conn_confs: Vec<(Url, ChainConnectionConf)> = match chain_conf.connection {
            Ethereum(conn) => Self::map_urls_to_connections(conn.rpc_urls(), conn, |conn, url| {
                let mut updated_conn = conn.clone();
                updated_conn.rpc_connection = RpcConnectionConf::Http { url };
                Ethereum(updated_conn)
            }),
            Fuel(_) => todo!("Fuel connection not implemented"),
            Sealevel(conn) => {
                Self::map_urls_to_connections(conn.urls.clone(), conn, |conn, url| {
                    let mut updated_conn = conn.clone();
                    updated_conn.urls = vec![url];
                    Sealevel(updated_conn)
                })
            }
            // We need only gRPC URLs for Cosmos and CosmosNative to create MerkleTreeHook
            Cosmos(conn) => {
                Self::map_urls_to_connections(conn.grpc_urls.clone(), conn, |conn, url| {
                    let mut updated_conn = conn.clone();
                    updated_conn.grpc_urls = vec![url];
                    Cosmos(updated_conn)
                })
            }
            CosmosNative(conn) => {
                Self::map_urls_to_connections(conn.grpc_urls.clone(), conn, |conn, url| {
                    let mut updated_conn = conn.clone();
                    updated_conn.grpc_urls = vec![url];
                    CosmosNative(updated_conn)
                })
            }
            Starknet(conn) => {
                Self::map_urls_to_connections(conn.urls.clone(), conn, |conn, url| {
                    let mut updated_conn = conn.clone();
                    updated_conn.urls = vec![url];
                    Starknet(updated_conn)
                })
            }
            Radix(conn) => Self::map_urls_to_connections(conn.core.clone(), conn, |conn, url| {
                let mut updated_conn = conn.clone();
                updated_conn.core = vec![url];
                Radix(updated_conn)
            }),
            Aleo(conn) => vec![(conn.rpc.clone(), ChainConnectionConf::Aleo(conn))],
            Sovereign(conn) => {
                Self::map_urls_to_connections(vec![conn.url.clone()], conn, |conn, url| {
                    let mut updated_conn = conn.clone();
                    updated_conn.url = url;
                    Sovereign(updated_conn)
                })
            }
        };

        chain_conn_confs
            .into_iter()
            .map(|(url, conn)| {
                let mut updated_settings = settings.clone();
                let mut chain_conf = settings
                    .chains
                    .get(origin)
                    .expect("Chain configuration is not found")
                    .clone();
                chain_conf.connection = conn;
                updated_settings.chains.insert(origin.clone(), chain_conf);
                (url, updated_settings)
            })
            .collect::<Vec<_>>()
    }

    fn map_urls_to_connections<T, F>(
        urls: Vec<Url>,
        conn: T,
        update_conn: F,
    ) -> Vec<(Url, ChainConnectionConf)>
    where
        F: Fn(&T, Url) -> ChainConnectionConf,
    {
        urls.into_iter()
            .map(|url| (url.clone(), update_conn(&conn, url)))
            .collect()
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
    pub(crate) async fn from_settings_with_storage_writer(
        settings: &ValidatorSettings,
        metrics: &CoreMetrics,
        storage_writer: Arc<dyn CheckpointSyncer>,
    ) -> eyre::Result<Self> {
        Ok(LatestCheckpointReorgReporterWithStorageWriter {
            latest_checkpoint_reorg_reporter: LatestCheckpointReorgReporter::from_settings(
                settings, metrics,
            )
            .await?,
            storage_writer,
        })
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
