use async_trait::async_trait;
use eyre::Result;
use uuid::Uuid;

use hyperlane_base::settings::{ChainConf, RawChainConf};

use crate::{
    adapter::{core::TxBuildingResult, AdaptsChain, GasLimit},
    error::LanderError,
    payload::{FullPayload, PayloadDetails},
    transaction::{Transaction, TransactionStatus},
};

pub struct CosmosAdapter {
    _conf: ChainConf,
    _raw_conf: RawChainConf,
}

impl CosmosAdapter {
    pub fn new(conf: ChainConf, raw_conf: RawChainConf) -> Self {
        Self {
            _conf: conf,
            _raw_conf: raw_conf,
        }
    }
}

#[async_trait]
impl AdaptsChain for CosmosAdapter {
    async fn estimate_gas_limit(
        &self,
        _payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError> {
        todo!()
    }

    async fn build_transactions(&self, _payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        todo!()
    }

    async fn simulate_tx(&self, _tx: &Transaction) -> Result<bool, LanderError> {
        todo!()
    }

    async fn estimate_tx(&self, _tx: &mut Transaction) -> std::result::Result<(), LanderError> {
        todo!()
    }

    async fn submit(&self, _tx: &mut Transaction) -> Result<(), LanderError> {
        todo!()
    }

    async fn get_tx_hash_status(
        &self,
        _hash: hyperlane_core::H512,
    ) -> std::result::Result<TransactionStatus, LanderError> {
        todo!()
    }

    async fn reverted_payloads(
        &self,
        _tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, LanderError> {
        todo!()
    }

    fn estimated_block_time(&self) -> &std::time::Duration {
        todo!()
    }

    fn max_batch_size(&self) -> u32 {
        todo!()
    }
}
