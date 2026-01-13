// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::sync::Arc;

use eyre::Result;

use hyperlane_base::{
    db::HyperlaneRocksDB,
    settings::{ChainConf, ChainConnectionConf, RawChainConf},
    CoreMetrics,
};

#[cfg(feature = "aleo")]
use crate::adapter::chains::aleo::AleoAdapter;
#[cfg(feature = "cosmos")]
use crate::adapter::chains::cosmos::CosmosAdapter;
use crate::adapter::chains::ethereum::EthereumAdapter;
#[cfg(feature = "radix")]
use crate::adapter::chains::radix::adapter::RadixAdapter;
#[cfg(feature = "sealevel")]
use crate::adapter::chains::sealevel::SealevelAdapter;
use crate::adapter::AdaptsChain;
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
        #[allow(unreachable_patterns)]
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
            #[cfg(feature = "fuel")]
            ChainConnectionConf::Fuel(_) => todo!(),
            #[cfg(feature = "sealevel")]
            ChainConnectionConf::Sealevel(_) => Arc::new(SealevelAdapter::new(
                conf.clone(),
                raw_conf.clone(),
                core_metrics,
            )?),
            #[cfg(feature = "cosmos")]
            ChainConnectionConf::Cosmos(_) => {
                Arc::new(CosmosAdapter::new(conf.clone(), raw_conf.clone()))
            }
            #[cfg(feature = "starknet")]
            ChainConnectionConf::Starknet(_) => todo!(),
            #[cfg(feature = "cosmos")]
            ChainConnectionConf::CosmosNative(_) => todo!(),
            #[cfg(feature = "radix")]
            ChainConnectionConf::Radix(connection_conf) => {
                let adapter = RadixAdapter::from_conf(conf, core_metrics, &connection_conf)?;
                Arc::new(adapter)
            }
            #[cfg(feature = "aleo")]
            ChainConnectionConf::Aleo(connection_conf) => {
                let adapter = AleoAdapter::from_conf(conf, core_metrics, &connection_conf)?;
                Arc::new(adapter)
            }
            _ => eyre::bail!("Unsupported chain connection type (feature not enabled)"),
        };
        Ok(adapter)
    }
}
