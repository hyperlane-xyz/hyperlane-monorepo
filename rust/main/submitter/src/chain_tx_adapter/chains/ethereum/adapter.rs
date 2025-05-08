use std::marker::PhantomData;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::contract::builders::ContractCall;
use ethers::prelude::U64;
use ethers::providers::Middleware;
use ethers::types::H256;
use tokio::sync::Mutex;
use tracing::{info, warn};
use uuid::Uuid;

use hyperlane_base::settings::parser::h_eth::{BuildableWithProvider, ConnectionConf};
use hyperlane_base::settings::{ChainConf, RawChainConf};
use hyperlane_base::CoreMetrics;
use hyperlane_core::ContractLocator;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForSubmitter, SubmitterProviderBuilder};

use crate::{
    chain_tx_adapter::{adapter::TxBuildingResult, AdaptsChain, GasLimit},
    payload::{FullPayload, PayloadDetails},
    transaction::{Transaction, TransactionStatus},
    SubmitterError,
};

use super::nonce::NonceManager;
use super::transaction::Precursor;
use super::EthereumTxPrecursor;

mod gas_limit_estimator;
mod tx_status_checker;

pub struct EthereumTxAdapter {
    conf: ChainConf,
    connection_conf: ConnectionConf,
    _raw_conf: RawChainConf,
    provider: Box<dyn EvmProviderForSubmitter>,
    reorg_period: EthereumReorgPeriod,
    nonce_manager: Arc<Mutex<NonceManager>>,
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
            address: hyperlane_core::H256::zero(),
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
        let nonce_manager = Arc::new(Mutex::new(NonceManager::new()));

        Ok(Self {
            conf,
            connection_conf,
            _raw_conf: raw_conf,
            provider,
            reorg_period,
            nonce_manager,
        })
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

    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        use super::transaction::TransactionFactory;

        info!(?payloads, "building transactions for payloads");
        let payloads_and_precursors = payloads
            .iter()
            .map(|payload| (EthereumTxPrecursor::from_payload(payload), payload))
            .collect::<Vec<(EthereumTxPrecursor, &FullPayload)>>();

        let mut transactions = Vec::new();
        for (precursor, payload) in payloads_and_precursors.into_iter() {
            let transaction = TransactionFactory::build(payload, precursor);
            transactions.push(TxBuildingResult::new(
                vec![payload.details.clone()],
                Some(transaction),
            ))
        }

        info!(?payloads, ?transactions, "built transactions for payloads");
        transactions
    }

    async fn simulate_tx(&self, _tx: &Transaction) -> Result<bool, SubmitterError> {
        todo!()
    }

    async fn estimate_tx(&self, tx: &mut Transaction) -> Result<(), SubmitterError> {
        let precursor = tx.precursor_mut();
        gas_limit_estimator::estimate_tx(
            &self.provider,
            precursor,
            &self.connection_conf.transaction_overrides,
            &self.conf.domain,
            true,
        )
        .await
    }

    async fn submit(&self, tx: &mut Transaction) -> Result<(), SubmitterError> {
        use super::transaction::Precursor;

        info!(?tx, "submitting transaction");

        self.nonce_manager
            .lock()
            .await
            .set_nonce(tx, &self.provider)
            .await?;

        let precursor = tx.precursor();
        let hash = self
            .provider
            .send(&precursor.tx, &precursor.function)
            .await?;

        tx.tx_hashes.push(hash.into());

        info!(?tx, "submitted transaction");

        Ok(())
    }

    async fn get_tx_hash_status(
        &self,
        hash: hyperlane_core::H512,
    ) -> Result<TransactionStatus, SubmitterError> {
        tx_status_checker::get_tx_hash_status(&self.provider, hash, &self.reorg_period).await
    }

    async fn reverted_payloads(
        &self,
        tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, SubmitterError> {
        let payload_details_and_precursors = tx
            .payload_details
            .iter()
            .filter_map(|d| EthereumTxPrecursor::from_success_criteria(d).map(|p| (d, p)))
            .collect::<Vec<_>>();

        let mut reverted = Vec::new();
        for (detail, precursor) in payload_details_and_precursors {
            let success = self
                .provider
                .check(&precursor.tx, &precursor.function)
                .await
                .unwrap_or(true);
            if !success {
                reverted.push(detail.clone());
            }
        }

        Ok(reverted)
    }

    fn estimated_block_time(&self) -> &std::time::Duration {
        todo!()
    }

    fn max_batch_size(&self) -> u32 {
        todo!()
    }

    async fn tx_in_finality(&self, count: usize) {
        self.nonce_manager.lock().await.tx_in_finality_count = count;
    }
}
