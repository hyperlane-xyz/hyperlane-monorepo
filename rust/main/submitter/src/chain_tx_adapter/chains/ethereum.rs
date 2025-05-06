use async_trait::async_trait;
use eyre::Result;

use hyperlane_base::settings::{ChainConf, RawChainConf};

use crate::{
    chain_tx_adapter::{adapter::TxBuildingResult, AdaptsChain, GasLimit},
    error::SubmitterError,
    payload::{FullPayload, PayloadDetails},
    transaction::{Transaction, TransactionStatus},
};

pub use precursor::EthereumTxPrecursor;

mod payload;
mod precursor;

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
    ) -> Result<Option<GasLimit>, SubmitterError> {
        todo!()
    }

    async fn build_transactions(&self, _payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        todo!()
    }

    async fn simulate_tx(&self, _tx: &Transaction) -> Result<bool, SubmitterError> {
        todo!()
    }

    async fn estimate_tx(&self, _tx: &mut Transaction) -> std::result::Result<(), SubmitterError> {
        todo!()
    }

    async fn submit(&self, _tx: &mut Transaction) -> Result<(), SubmitterError> {
        todo!()
    }

    async fn tx_status(&self, _tx: &Transaction) -> Result<TransactionStatus, SubmitterError> {
        todo!()
    }

    async fn reverted_payloads(
        &self,
        _tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, SubmitterError> {
        todo!()
    }

    fn estimated_block_time(&self) -> &std::time::Duration {
        todo!()
    }

    fn max_batch_size(&self) -> u32 {
        todo!()
    }
}
