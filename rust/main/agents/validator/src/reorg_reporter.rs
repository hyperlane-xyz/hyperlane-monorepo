use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::future::join_all;
use tracing::info;
use url::Url;

use hyperlane_base::settings::ChainConnectionConf;
use hyperlane_base::CoreMetrics;
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{HyperlaneDomain, MerkleTreeHook, ReorgPeriod};
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

#[async_trait]
impl ReorgReporter for LatestCheckpointReorgReporter {
    async fn report_at_block(&self, height: u64) {
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
            };

            futures.push(future);
        }

        join_all(futures).await;
    }

    async fn report_with_reorg_period(&self, reorg_period: &ReorgPeriod) {
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
            };

            futures.push(future);
        }

        join_all(futures).await;
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
            let merkle_tree_hook = settings
                .build_merkle_tree_hook(&settings.origin_chain, metrics)
                .await?;

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
            Cosmos, CosmosNative, Ethereum, Fuel, Kaspa, Sealevel, Starknet,
        };

        let chain_conf = settings
            .chains
            .get(origin.name())
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
                // Starknet only has a single RPC URL, so we can use it directly
                vec![(conn.url.clone(), ChainConnectionConf::Starknet(conn))]
            }
            Kaspa(conn) => {
                vec![(
                    Url::parse("http://localhost:16200").unwrap(),
                    ChainConnectionConf::Kaspa(conn),
                )] // TODO:
            }
        };

        chain_conn_confs
            .into_iter()
            .map(|(url, conn)| {
                let mut updated_settings = settings.clone();
                let mut chain_conf = settings
                    .chains
                    .get(origin.name())
                    .expect("Chain configuration is not found")
                    .clone();
                chain_conf.connection = conn;
                updated_settings
                    .chains
                    .insert(origin.name().to_string(), chain_conf);
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
