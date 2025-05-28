use std::{marker::PhantomData, sync::Arc, time::Duration};

use async_trait::async_trait;
use ethers::{contract::builders::ContractCall, prelude::U64, providers::Middleware, types::H256};
use eyre::eyre;
use tokio::sync::Mutex;
use tracing::{error, info, warn};
use uuid::Uuid;

use hyperlane_base::{
    db::HyperlaneRocksDB,
    settings::{
        parser::h_eth::{BuildableWithProvider, ConnectionConf},
        ChainConf, RawChainConf,
    },
    CoreMetrics,
};
use hyperlane_core::{config::OpSubmissionConfig, ContractLocator, HyperlaneDomain};
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander, SubmitterProviderBuilder};

use crate::{
    adapter::{core::TxBuildingResult, AdaptsChain, GasLimit},
    payload::{FullPayload, PayloadDetails},
    transaction::{Transaction, TransactionStatus},
    LanderError,
};

use super::{nonce::NonceManager, transaction::Precursor, EthereumTxPrecursor};

mod gas_limit_estimator;
mod gas_price_estimator;
mod tx_status_checker;

pub struct EthereumAdapter {
    pub estimated_block_time: Duration,
    pub domain: HyperlaneDomain,
    pub transaction_overrides: hyperlane_ethereum::TransactionOverrides,
    pub submission_config: OpSubmissionConfig,
    pub provider: Arc<dyn EvmProviderForLander>,
    pub reorg_period: EthereumReorgPeriod,
    pub nonce_manager: NonceManager,
}

impl EthereumAdapter {
    pub async fn new(
        conf: ChainConf,
        connection_conf: ConnectionConf,
        _raw_conf: RawChainConf,
        db: Arc<HyperlaneRocksDB>,
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
        let nonce_manager = NonceManager::new(&conf, db, provider.clone()).await?;

        let adapter = Self {
            estimated_block_time: conf.estimated_block_time,
            domain: conf.domain.clone(),
            transaction_overrides: connection_conf.transaction_overrides.clone(),
            submission_config: connection_conf.op_submission_config.clone(),
            provider,
            reorg_period,
            nonce_manager,
        };

        Ok(adapter)
    }

    async fn set_nonce_if_needed(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        self.nonce_manager.assign_nonce(tx).await?;
        Ok(())
    }

    async fn set_gas_limit_if_needed(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        if tx.precursor().tx.gas().is_none() {
            self.estimate_tx(tx).await?;
        }
        Ok(())
    }

    async fn set_gas_price(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        if tx.precursor().tx.gas_price().is_none() {
            gas_price_estimator::estimate_gas_price(
                &self.provider,
                tx.precursor_mut(),
                &self.transaction_overrides,
                &self.domain,
            )
            .await?;
            info!(?tx, "estimated gas price for transaction");
        }
        Ok(())
    }
}

#[async_trait]
impl AdaptsChain for EthereumAdapter {
    async fn estimate_gas_limit(
        &self,
        _payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError> {
        todo!()
    }

    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        use super::transaction::TransactionFactory;

        info!(?payloads, "building transactions for payloads");
        let Some(signer) = self.provider.get_signer() else {
            error!("No signer found! Cannot build transactions");
            return vec![];
        };
        let payloads_and_precursors = payloads
            .iter()
            .map(|payload| (EthereumTxPrecursor::from_payload(payload, signer), payload))
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

    async fn simulate_tx(&self, _tx: &Transaction) -> Result<bool, LanderError> {
        todo!()
    }

    async fn estimate_tx(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        let precursor = tx.precursor_mut();
        gas_limit_estimator::estimate_gas_limit(
            self.provider.clone(),
            precursor,
            &self.transaction_overrides,
            &self.domain,
            true,
        )
        .await
    }

    async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        use super::transaction::Precursor;

        self.set_nonce_if_needed(tx).await?;
        self.set_gas_limit_if_needed(tx).await?;
        self.set_gas_price(tx).await?;

        info!(?tx, "submitting transaction");

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
    ) -> Result<TransactionStatus, LanderError> {
        tx_status_checker::get_tx_hash_status(&self.provider, hash, &self.reorg_period).await
    }

    async fn on_tx_status(&self, tx: &Transaction, tx_status: &TransactionStatus) {
        self.nonce_manager.update_nonce_status(tx, tx_status).await;
    }

    async fn reverted_payloads(
        &self,
        tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, LanderError> {
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
        &self.estimated_block_time
    }

    fn max_batch_size(&self) -> u32 {
        self.submission_config.max_batch_size
    }
}
