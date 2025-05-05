use async_trait::async_trait;
use ethers::{providers::Middleware, types::U64};
use eyre::Result;
use hyperlane_core::{ContractLocator, H256};
use hyperlane_ethereum::{
    ConnectionConf, EthereumReorgPeriod, EvmProviderForSubmitter, SubmitterProviderBuilder,
};
use tracing::warn;
use uuid::Uuid;

use hyperlane_base::{
    settings::{ChainConf, RawChainConf},
    CoreMetrics,
};

use crate::{
    chain_tx_adapter::{adapter::TxBuildingResult, AdaptsChain, GasLimit},
    error::SubmitterError,
    payload::{FullPayload, PayloadDetails},
    transaction::{Transaction, TransactionStatus},
};

pub struct EthereumTxAdapter {
    conf: ChainConf,
    _raw_conf: RawChainConf,
    provider: Box<dyn EvmProviderForSubmitter>,
    reorg_period: EthereumReorgPeriod,
}

impl EthereumTxAdapter {
    pub async fn new(
        conf: ChainConf,
        connection_conf: ConnectionConf,
        raw_conf: RawChainConf,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Self> {
        let locator = ContractLocator {
            domain: &conf.domain,
            address: H256::zero(),
        };
        let provider = conf
            .build_ethereum(
                &connection_conf,
                &locator,
                metrics,
                SubmitterProviderBuilder {},
            )
            .await?;
        let reorg_period = EthereumReorgPeriod::try_from(&conf.reorg_period)?;

        Ok(Self {
            conf,
            _raw_conf: raw_conf,
            provider,
            reorg_period,
        })
    }

    async fn block_number_result_to_tx_hash(&self, block_number: Option<U64>) -> TransactionStatus {
        let Some(block_number) = block_number else {
            return TransactionStatus::PendingInclusion;
        };
        let block_number = block_number.as_u64();
        let sts = match self
            .reorg_period
            .is_block_finalized(self.provider, block_number)
            .await
        {
            Ok(true) => TransactionStatus::Finalized,
            Ok(false) => TransactionStatus::Included,
            Err(err) => {
                warn!(?err, "Error checking block finality");
                TransactionStatus::PendingInclusion
            }
        };
        sts
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

    async fn get_tx_hash_status(
        &self,
        hash: hyperlane_core::H512,
    ) -> Result<TransactionStatus, SubmitterError> {
        let tx_hash_status = match self.provider.get_transaction_receipt(hash.into()).await {
            Ok(None) => Err(SubmitterError::TxHashNotFound(
                "Transaction not found".to_string(),
            )),
            Ok(Some(receipt)) => {
                if receipt.status == Some(1.into()) {
                    Ok(TransactionStatus::Success)
                } else {
                    Ok(TransactionStatus::Failed)
                }
            }
            Err(err) => Err(SubmitterError::TxHashNotFound(err.to_string())),
        };
    }
}
