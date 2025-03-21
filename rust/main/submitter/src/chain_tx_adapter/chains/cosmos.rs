use async_trait::async_trait;
use uuid::Uuid;

use hyperlane_base::settings::ChainConf;

use crate::chain_tx_adapter::{AdaptsChain, FullPayload, GasLimit, Transaction, TransactionStatus};

pub struct CosmosTxAdapter {
    _conf: ChainConf,
}

impl CosmosTxAdapter {
    pub fn new(conf: ChainConf) -> Self {
        Self { _conf: conf }
    }
}

#[async_trait]
impl AdaptsChain for CosmosTxAdapter {
    async fn estimate_gas_limit(&self, _payload: &FullPayload) -> eyre::Result<GasLimit> {
        todo!()
    }

    async fn build_transactions(&self, _payloads: Vec<FullPayload>) -> Vec<Transaction> {
        todo!()
    }

    async fn simulate_tx(&self, _tx: &Transaction) -> eyre::Result<bool> {
        todo!()
    }

    async fn submit(&self, _tx: &mut Transaction) -> eyre::Result<()> {
        todo!()
    }

    async fn tx_status(&self, _tx: &Transaction) -> eyre::Result<TransactionStatus> {
        todo!()
    }

    async fn reverted_payloads(&self, _tx: &Transaction) -> eyre::Result<Vec<Uuid>> {
        todo!()
    }
}
