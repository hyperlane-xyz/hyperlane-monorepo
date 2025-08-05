// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::sync::Arc;

use eyre::Result;

use hyperlane_base::{
    db::HyperlaneRocksDB,
    settings::{ChainConf, ChainConnectionConf, RawChainConf},
    CoreMetrics,
};

use crate::adapter::{
    chains::{cosmos::CosmosAdapter, ethereum::EthereumAdapter, sealevel::SealevelAdapter},
    AdaptsChain,
};
use crate::DispatcherMetrics;

pub struct AdapterFactory {}

impl AdapterFactory {
    pub async fn build(
        conf: &ChainConf,
        raw_conf: &RawChainConf,
        db: Arc<HyperlaneRocksDB>,
        core_metrics: &CoreMetrics,
        dispatcher_metrics: DispatcherMetrics,
    ) -> Result<Arc<dyn AdaptsChain>> {
        let adapter: Arc<dyn AdaptsChain> = match conf.connection.clone() {
            ChainConnectionConf::Ethereum(connection_conf) => Arc::new(
                EthereumAdapter::new(
                    conf.clone(),
                    connection_conf,
                    raw_conf.clone(),
                    db,
                    core_metrics,
                    dispatcher_metrics,
                )
                .await?,
            ),
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => Arc::new(SealevelAdapter::new(
                conf.clone(),
                raw_conf.clone(),
                core_metrics,
            )?),
            ChainConnectionConf::Cosmos(_) => {
                Arc::new(CosmosAdapter::new(conf.clone(), raw_conf.clone()))
            }
            ChainConnectionConf::Starknet(_) => todo!(),
            ChainConnectionConf::CosmosNative(_) => todo!(),
        };

        Ok(adapter)
    }
}
