// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::sync::Arc;

use eyre::Result;

use crate::chain_tx_adapter::{
    chains::{cosmos::CosmosTxAdapter, ethereum::EthereumTxAdapter, sealevel::SealevelTxAdapter},
    AdaptsChain,
};
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_base::{
    settings::{ChainConf, ChainConnectionConf, RawChainConf},
    CoreMetrics,
};

pub struct ChainTxAdapterFactory {}

impl ChainTxAdapterFactory {
    pub async fn build(
        conf: &ChainConf,
        raw_conf: &RawChainConf,
        metrics: &CoreMetrics,
        db: Arc<HyperlaneRocksDB>,
    ) -> Result<Arc<dyn AdaptsChain>> {
        let adapter: Arc<dyn AdaptsChain> = match conf.connection.clone() {
            ChainConnectionConf::Ethereum(connection_conf) => Arc::new(
                EthereumTxAdapter::new(
                    conf.clone(),
                    connection_conf,
                    raw_conf.clone(),
                    db,
                    metrics,
                )
                .await?,
            ),
            ChainConnectionConf::Fuel(_) => todo!(),
            ChainConnectionConf::Sealevel(_) => Arc::new(SealevelTxAdapter::new(
                conf.clone(),
                raw_conf.clone(),
                metrics,
            )?),
            ChainConnectionConf::Cosmos(_) => {
                Arc::new(CosmosTxAdapter::new(conf.clone(), raw_conf.clone()))
            }
            ChainConnectionConf::Starknet(_) => todo!(),
            ChainConnectionConf::CosmosNative(_) => todo!(),
        };

        Ok(adapter)
    }
}
