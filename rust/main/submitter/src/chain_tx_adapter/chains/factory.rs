// TODO: re-enable clippy warnings
#![allow(dead_code)]

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
    ) -> Result<Box<dyn AdaptsChain>> {
        use HyperlaneDomainProtocol::*;

        let adapter: Box<dyn AdaptsChain> = match conf.domain.domain_protocol() {
            Ethereum => Box::new(EthereumTxAdapter::new(conf.clone(), raw_conf.clone())),
            Fuel => todo!(),
            Sealevel => Box::new(SealevelTxAdapter::new(
                conf.clone(),
                raw_conf.clone(),
                metrics,
            )?),
            Cosmos => Box::new(CosmosTxAdapter::new(conf.clone(), raw_conf.clone())),
            CosmosNative => todo!(),
        };

        Ok(adapter)
    }
}
