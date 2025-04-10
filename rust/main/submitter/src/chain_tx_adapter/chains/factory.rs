// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::sync::Arc;

use eyre::Result;
use hyperlane_base::{
    settings::{ChainConf, RawChainConf},
    CoreMetrics,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneDomainProtocol};

use crate::chain_tx_adapter::{
    chains::{cosmos::CosmosTxAdapter, ethereum::EthereumTxAdapter, sealevel::SealevelTxAdapter},
    AdaptsChain,
};

pub struct ChainTxAdapterFactory {}

impl ChainTxAdapterFactory {
    pub fn build(
        conf: &ChainConf,
        raw_conf: &RawChainConf,
        metrics: &CoreMetrics,
    ) -> Result<Arc<dyn AdaptsChain>> {
        use HyperlaneDomainProtocol::*;

        let adapter: Arc<dyn AdaptsChain> = match conf.domain.domain_protocol() {
            Ethereum => Arc::new(EthereumTxAdapter::new(conf.clone(), raw_conf.clone())),
            Fuel => todo!(),
            Sealevel => Arc::new(SealevelTxAdapter::new(
                conf.clone(),
                raw_conf.clone(),
                metrics,
            )?),
            Cosmos => Arc::new(CosmosTxAdapter::new(conf.clone(), raw_conf.clone())),
            CosmosNative => todo!(),
        };

        Ok(adapter)
    }
}
