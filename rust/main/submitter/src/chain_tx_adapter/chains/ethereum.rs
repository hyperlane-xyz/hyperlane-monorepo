use async_trait::async_trait;
use eyre::Result;
use uuid::Uuid;

use hyperlane_base::settings::{ChainConf, RawChainConf};

use crate::{
    chain_tx_adapter::{adapter::TxBuildingResult, AdaptsChain, DispatcherError, GasLimit},
    payload::FullPayload,
    transaction::{Transaction, TransactionStatus},
};

pub struct EthereumTxAdapter {
    _conf: ChainConf,
    _raw_conf: RawChainConf,
}

impl EthereumTxAdapter {
    pub fn new(conf: ChainConf, raw_conf: RawChainConf) -> Self {
        Self {
            _conf: conf,
            _raw_conf: raw_conf,
        }
    }
}

#[async_trait]
impl AdaptsChain for EthereumTxAdapter {
    async fn estimate_gas_limit(
        &self,
        _payload: &FullPayload,
    ) -> Result<Option<GasLimit>, DispatcherError> {
        todo!()
    }

    async fn build_transactions(
        &self,
        _payloads: &[FullPayload],
    ) -> Result<Vec<TxBuildingResult>, DispatcherError> {
        todo!()
    }

    async fn simulate_tx(&self, _tx: &Transaction) -> Result<bool, DispatcherError> {
        todo!()
    }

    async fn submit(&self, _tx: &mut Transaction) -> Result<(), DispatcherError> {
        todo!()
    }

    async fn tx_status(&self, _tx: &Transaction) -> Result<TransactionStatus, DispatcherError> {
        todo!()
    }

    async fn reverted_payloads(
        &self,
        _tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, DispatcherError> {
        todo!()
    }

    fn estimated_block_time(&self) -> std::time::Duration {
        todo!()
    }

    fn max_batch_size(&self) -> usize {
        todo!()
    }
}
