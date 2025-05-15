use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use tracing::info;
use url::Url;

use hyperlane_base::settings::ChainConnectionConf;
use hyperlane_base::CoreMetrics;
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{HyperlaneDomain, MerkleTreeHook};
use hyperlane_ethereum::RpcConnectionConf;

use crate::settings::ValidatorSettings;

#[async_trait]
pub trait ReorgReporter: Send + Sync + Debug {
    async fn report(&self);
}

#[derive(Debug)]
pub struct LatestCheckpointReorgReporter {
    merkle_tree_hooks: HashMap<Url, Arc<dyn MerkleTreeHook>>,
    reorg_period: hyperlane_core::ReorgPeriod,
}

#[async_trait]
impl ReorgReporter for LatestCheckpointReorgReporter {
    async fn report(&self) {
        for (url, merkle_tree_hook) in &self.merkle_tree_hooks {
            let latest_checkpoint = call_and_retry_indefinitely(|| {
                let merkle_tree_hook = merkle_tree_hook.clone();
                let reorg_period = self.reorg_period.clone();
                Box::pin(async move { merkle_tree_hook.latest_checkpoint(&reorg_period).await })
            })
            .await;

            info!(
                "Latest checkpoint on reorg for {}: {:?}",
                url, latest_checkpoint
            );
        }
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

        let reporter = LatestCheckpointReorgReporter {
            merkle_tree_hooks,
            reorg_period: settings.reorg_period.clone(),
        };

        Ok(reporter)
    }

    fn settings_with_single_rpc(
        settings: &ValidatorSettings,
        origin: &HyperlaneDomain,
    ) -> Vec<(Url, ValidatorSettings)> {
        use ChainConnectionConf::{Cosmos, CosmosNative, Ethereum, Fuel, Sealevel};

        let chain_conf = settings
            .chains
            .get(origin.name())
            .expect("Chain configuration is not found")
            .clone();

        let chain_conn_confs = match chain_conf.connection {
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
