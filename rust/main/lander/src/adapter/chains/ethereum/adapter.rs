use std::{marker::PhantomData, sync::Arc, time::Duration};

use async_trait::async_trait;
use ethers::{
    contract::builders::ContractCall,
    prelude::U64,
    providers::Middleware,
    types::{transaction::eip2718::TypedTransaction, H256},
};
use eyre::eyre;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};
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
    dispatcher::VmSpecificMetricsSource,
    payload::{FullPayload, PayloadDetails},
    transaction::{Transaction, TransactionStatus, VmSpecificTxData},
    DispatcherMetrics, LanderError,
};

use super::{
    metrics::EthereumAdapterMetrics, nonce::NonceManager, transaction::Precursor,
    EthereumTxPrecursor,
};

mod gas_limit_estimator;
mod gas_price;
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
        dispatcher_metrics: DispatcherMetrics,
    ) -> eyre::Result<Self> {
        let domain = conf.domain.name();

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

        let signer = provider
            .get_signer()
            .map_or("none".to_string(), |s| s.to_string());

        let metrics = EthereumAdapterMetrics::new(
            dispatcher_metrics.get_finalized_nonce(domain, &signer),
            dispatcher_metrics.get_upper_nonce(domain, &signer),
        );

        let reorg_period = EthereumReorgPeriod::try_from(&conf.reorg_period)?;
        let nonce_manager = NonceManager::new(&conf, db, provider.clone(), metrics).await?;

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
        // even if the gas price is already set, we still want to (re-)estimate it
        // to be resilient to gas spikes
        let old_tx_precursor = tx.precursor().clone();
        let new_tx_precursor = tx.precursor_mut();

        // first, estimate the gas price and set it on the new transaction precursor
        gas_price::estimator::estimate_gas_price(
            &self.provider,
            new_tx_precursor,
            &self.transaction_overrides,
            &self.domain,
        )
        .await?;

        // then, compare the estimated gas price with `current * escalation_multiplier`
        gas_price::escalator::escalate_gas_price_if_needed(&old_tx_precursor, new_tx_precursor);

        info!(old=?old_tx_precursor, new=?tx.precursor(), "estimated gas price for transaction");
        Ok(())
    }

    fn extract_vm_specific_metrics(tx: &Transaction) -> VmSpecificMetricsSource {
        let mut metrics_source = VmSpecificMetricsSource::default();
        let precursor = tx.precursor().clone();

        if let TypedTransaction::Eip1559(precursor) = &precursor.tx {
            if let Some(max_prio_fee) = precursor.max_priority_fee_per_gas {
                metrics_source.priority_fee = Some(max_prio_fee.as_u64());
            }
            if let Some(max_fee) = precursor.max_fee_per_gas {
                metrics_source.gas_price = Some(max_fee.as_u64());
            }
        } else {
            // for legacy transactions, we can only set the gas price
            if let Some(gas_price) = precursor.tx.gas_price() {
                metrics_source.gas_price = Some(gas_price.as_u64());
            }
        }
        metrics_source
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
        if tx.precursor().tx.gas().is_some() {
            debug!(
                ?tx,
                "skipping gas limit estimation for transaction, as it was already estimated"
            );
            return Ok(());
        }
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

    fn update_vm_specific_metrics(&self, tx: &Transaction, metrics: &DispatcherMetrics) {
        let metrics_source = Self::extract_vm_specific_metrics(tx);
        metrics.set_vm_specific_metrics(&metrics_source, self.domain.as_ref());
    }

    fn estimated_block_time(&self) -> &std::time::Duration {
        &self.estimated_block_time
    }

    fn max_batch_size(&self) -> u32 {
        self.submission_config.max_batch_size
    }
}

#[cfg(test)]
mod tests {
    use ethers::types::{
        transaction::{eip2718::TypedTransaction, eip2930::AccessList},
        Eip1559TransactionRequest, Eip2930TransactionRequest, TransactionRequest, H160, H256,
    };

    use crate::{
        adapter::EthereumTxPrecursor,
        tests::ethereum::inclusion_stage::{dummy_evm_tx, dummy_tx_precursor},
        transaction::VmSpecificTxData,
    };

    #[test]
    fn vm_specific_metrics_are_extracted_correctly_legacy() {
        use super::EthereumAdapter;
        use crate::transaction::Transaction;

        let mut evm_tx = dummy_evm_tx(
            vec![],
            crate::TransactionStatus::PendingInclusion,
            H160::random(),
        );

        if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut evm_tx.vm_specific_data {
            ethereum_tx_precursor.tx = TypedTransaction::Legacy(TransactionRequest {
                from: Some(H160::random()),
                to: Some(H160::random().into()),
                nonce: Some(0.into()),
                gas: Some(21000.into()),
                gas_price: Some(1000000000.into()),
                value: Some(1.into()),
                ..Default::default()
            });
        }

        let metrics_source = EthereumAdapter::extract_vm_specific_metrics(&evm_tx);
        assert_eq!(metrics_source.gas_price.unwrap(), 1000000000);
        assert_eq!(metrics_source.priority_fee, None);
    }

    #[test]
    fn vm_specific_metrics_are_extracted_correctly_eip1559() {
        use super::EthereumAdapter;
        use crate::transaction::Transaction;

        let mut evm_tx = dummy_evm_tx(
            vec![],
            crate::TransactionStatus::PendingInclusion,
            H160::random(),
        );

        if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut evm_tx.vm_specific_data {
            ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
                from: Some(H160::random()),
                to: Some(H160::random().into()),
                nonce: Some(0.into()),
                max_fee_per_gas: Some(1000000000.into()),
                max_priority_fee_per_gas: Some(22222.into()),
                value: Some(1.into()),
                ..Default::default()
            });
        }

        let metrics_source = EthereumAdapter::extract_vm_specific_metrics(&evm_tx);
        assert_eq!(metrics_source.gas_price.unwrap(), 1000000000);
        assert_eq!(metrics_source.priority_fee.unwrap(), 22222);
    }

    #[test]
    fn vm_specific_metrics_are_extracted_correctly_eip2930() {
        use super::EthereumAdapter;
        use crate::transaction::Transaction;

        let mut evm_tx = dummy_evm_tx(
            vec![],
            crate::TransactionStatus::PendingInclusion,
            H160::random(),
        );

        if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut evm_tx.vm_specific_data {
            ethereum_tx_precursor.tx = TypedTransaction::Eip2930(Eip2930TransactionRequest {
                tx: TransactionRequest {
                    from: Some(H160::random()),
                    to: Some(H160::random().into()),
                    nonce: Some(0.into()),
                    gas: Some(21000.into()),
                    gas_price: Some(1000000000.into()),
                    value: Some(1.into()),
                    ..Default::default()
                },
                access_list: AccessList::default(),
            });
        }

        let metrics_source = EthereumAdapter::extract_vm_specific_metrics(&evm_tx);
        assert_eq!(metrics_source.gas_price.unwrap(), 1000000000);
        assert_eq!(metrics_source.priority_fee, None);
    }
}
