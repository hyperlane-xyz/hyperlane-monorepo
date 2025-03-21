// TODO: re-enable clippy warnings
#![allow(dead_code)]

use hyperlane_base::settings::ChainConf;
use hyperlane_core::{HyperlaneDomain, HyperlaneDomainProtocol};

use crate::chain_tx_adapter::{
    chains::{
        cosmos::CosmosChainTxAdapter, ethereum::EthereumChainTxAdapter,
        sealevel::SealevelChainTxAdapter,
    },
    AdaptsChain,
};

pub struct ChainTxAdapterBuilder {}

impl ChainTxAdapterBuilder {
    pub fn build(conf: &ChainConf) -> Box<dyn AdaptsChain> {
        use HyperlaneDomainProtocol::*;

        let adapter: Box<dyn AdaptsChain> = match conf.domain.domain_protocol() {
            Ethereum => Box::new(EthereumChainTxAdapter::new(conf.clone())),
            Fuel => todo!(),
            Sealevel => Box::new(SealevelChainTxAdapter::new(conf.clone())),
            Cosmos => Box::new(CosmosChainTxAdapter::new(conf.clone())),
        };

        adapter
    }
}
