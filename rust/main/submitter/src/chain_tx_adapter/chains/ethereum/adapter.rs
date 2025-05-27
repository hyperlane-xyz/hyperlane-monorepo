use std::marker::PhantomData;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::contract::builders::ContractCall;
use ethers::prelude::U64;
use ethers::providers::Middleware;
use ethers::types::H256;
use eyre::eyre;
use tokio::sync::Mutex;
use tracing::{error, info, warn};
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
mod gas_price_estimator;
mod tx_status_checker;

pub struct EthereumTxAdapter {
    estimated_block_time: Duration,
    max_batch_size: u32,
    conf: ChainConf,
    connection_conf: ConnectionConf,
    _raw_conf: RawChainConf,
    provider: Box<dyn EvmProviderForSubmitter>,
    reorg_period: EthereumReorgPeriod,
    nonce_manager: NonceManager,
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

        let nonce_manager = NonceManager::new(&conf).await?;
        let estimated_block_time = conf.estimated_block_time;
        let max_batch_size = Self::batch_size(&conf)?;

        Ok(Self {
            estimated_block_time,
            max_batch_size,
            conf,
            connection_conf,
            _raw_conf: raw_conf,
            provider,
            reorg_period,
            nonce_manager,
        })
    }

    fn batch_size(conf: &ChainConf) -> eyre::Result<u32> {
        Ok(conf
            .connection
            .operation_submission_config()
            .ok_or_else(|| eyre!("no operation batch config"))?
            .max_batch_size)
    }

    async fn set_nonce_if_needed(&self, tx: &mut Transaction) -> Result<(), SubmitterError> {
        self.nonce_manager.set_nonce(tx, &self.provider).await?;
        Ok(())
    }

    async fn set_gas_limit_if_needed(&self, tx: &mut Transaction) -> Result<(), SubmitterError> {
        if tx.precursor().tx.gas().is_none() {
            self.estimate_tx(tx).await?;
        }
        Ok(())
    }

    async fn set_gas_price(&self, tx: &mut Transaction) -> Result<(), SubmitterError> {
        if tx.precursor().tx.gas_price().is_none() {
            gas_price_estimator::estimate_gas_price(
                &self.provider,
                tx.precursor_mut(),
                &self.connection_conf.transaction_overrides,
                &self.conf.domain,
            )
            .await?;
            info!(?tx, "estimated gas price for transaction");
        }
        Ok(())
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

    async fn simulate_tx(&self, _tx: &Transaction) -> Result<bool, SubmitterError> {
        todo!()
    }

    async fn estimate_tx(&self, tx: &mut Transaction) -> Result<(), SubmitterError> {
        let precursor = tx.precursor_mut();
        gas_limit_estimator::estimate_gas_limit(
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
        &self.estimated_block_time
    }

    fn max_batch_size(&self) -> u32 {
        self.max_batch_size
    }

    async fn set_unfinalized_tx_count(&self, count: usize) {
        self.nonce_manager.set_tx_in_finality_count(count).await;
    }
}
