use std::collections::HashMap;
use std::sync::Arc;

use tracing::info;
use url::Url;

use hyperlane_base::settings::ChainConnectionConf;
use hyperlane_base::CoreMetrics;
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{HyperlaneDomain, MerkleTreeHook};
use hyperlane_ethereum::RpcConnectionConf;

use crate::settings::ValidatorSettings;

#[derive(Debug)]
pub struct ReorgReporter {
    hooks: HashMap<Url, Arc<dyn MerkleTreeHook>>,
    reorg_period: hyperlane_core::ReorgPeriod,
}

impl ReorgReporter {
    pub async fn report(&self) {
        for (url, merkle_tree_hook) in &self.hooks {
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

    pub(crate) async fn from_settings(
        settings: &ValidatorSettings,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Self> {
        let origin = &settings.origin_chain;

        let mut hooks = HashMap::new();
        for (url, settings) in Self::settings_with_single_rpc(settings, origin) {
            let merkle_tree_hook = settings
                .build_merkle_tree_hook(&settings.origin_chain, metrics)
                .await?;

            hooks.insert(url, merkle_tree_hook.into());
        }

        let reporter = ReorgReporter {
            hooks,
            reorg_period: settings.reorg_period.clone(),
        };

        Ok(reporter)
    }

    fn settings_with_single_rpc(
        settings: &ValidatorSettings,
        origin: &HyperlaneDomain,
    ) -> Vec<(Url, ValidatorSettings)> {
        let chain_conf = settings
            .chains
            .get(origin.name())
            .expect("Chain configuration is not found")
            .clone();

        let chain_conn_confs = match chain_conf.connection {
            ChainConnectionConf::Ethereum(conn) => {
                let conn_copy = conn.clone();

                let urls = match conn.rpc_connection {
                    RpcConnectionConf::HttpQuorum { urls } => urls,
                    RpcConnectionConf::HttpFallback { urls } => urls,
                    RpcConnectionConf::Http { url } => vec![url],
                    RpcConnectionConf::Ws { .. } => panic!("Websocket connection not supported"),
                };

                urls.into_iter()
                    .map(|url| {
                        let mut updated_conn = conn_copy.clone();
                        let rpc_conn_conf = RpcConnectionConf::Http { url: url.clone() };

                        updated_conn.rpc_connection = rpc_conn_conf;
                        (url, ChainConnectionConf::Ethereum(updated_conn))
                    })
                    .collect::<Vec<_>>()
            }
            ChainConnectionConf::Fuel(_) => todo!("Fuel connection not implemented"),
            ChainConnectionConf::Sealevel(conn) => {
                let conn_copy = conn.clone();
                conn.urls
                    .into_iter()
                    .map(|url| {
                        let mut updated_conn = conn_copy.clone();
                        updated_conn.urls = vec![url.clone()];
                        (url, ChainConnectionConf::Sealevel(updated_conn))
                    })
                    .collect::<Vec<_>>()
            }
            ChainConnectionConf::Cosmos(conn) => {
                let conn_copy = conn.clone();
                conn.grpc_urls
                    .into_iter()
                    .map(|url| {
                        let mut updated_conn = conn_copy.clone();
                        updated_conn.grpc_urls = vec![url.clone()];
                        (url, ChainConnectionConf::Cosmos(updated_conn))
                    })
                    .collect::<Vec<_>>()
            }
            ChainConnectionConf::CosmosNative(conn) => {
                let conn_copy = conn.clone();
                conn.grpc_urls
                    .into_iter()
                    .map(|url| {
                        let mut updated_conn = conn_copy.clone();
                        updated_conn.grpc_urls = vec![url.clone()];
                        (url, ChainConnectionConf::CosmosNative(updated_conn))
                    })
                    .collect::<Vec<_>>()
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
}
