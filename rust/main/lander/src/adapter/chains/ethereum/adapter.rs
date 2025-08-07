use std::{marker::PhantomData, sync::Arc, time::Duration};

use async_trait::async_trait;
use ethers::prelude::{Address, H160};
use ethers::{
    contract::builders::ContractCall, prelude::U64, providers::Middleware,
    types::transaction::eip2718::TypedTransaction,
};
use ethers_core::abi::Function;
use ethers_core::types::Eip1559TransactionRequest;
use eyre::eyre;
use futures_util::future;
use tokio::sync::Mutex;
use tokio::try_join;
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;

use hyperlane_base::{
    db::HyperlaneRocksDB,
    settings::{
        parser::h_eth::{BuildableWithProvider, ConnectionConf},
        ChainConf, RawChainConf,
    },
    CoreMetrics,
};
use hyperlane_core::{config::OpSubmissionConfig, ContractLocator, HyperlaneDomain, H256, U256};
use hyperlane_ethereum::multicall::BatchCache;
use hyperlane_ethereum::{
    multicall, EthereumReorgPeriod, EvmProviderForLander, LanderProviderBuilder,
};

use crate::{
    adapter::{core::TxBuildingResult, AdaptsChain, GasLimit},
    dispatcher::{PayloadDb, PostInclusionMetricsSource, TransactionDb},
    payload::{FullPayload, PayloadDetails},
    transaction::{Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData},
    DispatcherMetrics, LanderError,
};

use super::{
    metrics::EthereumAdapterMetrics, nonce::NonceManager, transaction::Precursor,
    EthereumTxPrecursor,
};

use gas_price::GasPrice;

mod gas_limit_estimator;
mod gas_price;
mod tx_status_checker;

const NONCE_TOO_LOW_ERROR: &str = "nonce too low";
const DEFAULT_MINIMUM_TIME_BETWEEN_RESUBMISSIONS: Duration = Duration::from_secs(1);

pub struct EthereumAdapter {
    pub estimated_block_time: Duration,
    pub domain: HyperlaneDomain,
    pub transaction_overrides: hyperlane_ethereum::TransactionOverrides,
    pub submission_config: OpSubmissionConfig,
    pub provider: Arc<dyn EvmProviderForLander>,
    pub reorg_period: EthereumReorgPeriod,
    pub nonce_manager: NonceManager,
    pub batch_cache: Arc<Mutex<BatchCache>>,
    pub batch_contract_address: H256,
    pub payload_db: Arc<dyn PayloadDb>,
    pub signer: H160,
    pub minimum_time_between_resubmissions: Duration,
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
            address: H256::zero(),
        };
        let provider = conf
            .build_ethereum(
                &connection_conf,
                &locator,
                metrics,
                LanderProviderBuilder {},
            )
            .await?;

        let signer = provider
            .get_signer()
            .ok_or_else(|| eyre!("No signer found in provider for domain {}", domain))?;

        let metrics = EthereumAdapterMetrics::new(
            dispatcher_metrics.get_finalized_nonce(domain, &signer.to_string()),
            dispatcher_metrics.get_upper_nonce(domain, &signer.to_string()),
        );

        let payload_db = db.clone() as Arc<dyn PayloadDb>;

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
            batch_cache: Default::default(),
            batch_contract_address: connection_conf.batch_contract_address(),
            payload_db,
            signer,
            minimum_time_between_resubmissions: DEFAULT_MINIMUM_TIME_BETWEEN_RESUBMISSIONS,
        };

        Ok(adapter)
    }

    async fn calculate_nonce(&self, tx: &Transaction) -> Result<Option<U256>, LanderError> {
        self.nonce_manager.calculate_next_nonce(tx).await
    }

    async fn estimate_gas_price(&self, tx: &Transaction) -> Result<GasPrice, LanderError> {
        // even if the gas price is already set, we still want to (re-)estimate it
        // to be resilient to gas spikes
        let old_tx_precursor = tx.precursor();

        let old_gas_price = gas_price::extract_gas_price(old_tx_precursor);

        // first, estimate the gas price
        let estimated_gas_price = gas_price::estimate_gas_price(
            &self.provider,
            old_tx_precursor,
            &self.transaction_overrides,
            &self.domain,
        )
        .await;

        // then, compare the estimated gas price with `current * escalation_multiplier`
        let escalated_gas_price =
            gas_price::escalate_gas_price_if_needed(&old_gas_price, &estimated_gas_price);

        let new_gas_price = match escalated_gas_price {
            GasPrice::None => estimated_gas_price,
            _ => escalated_gas_price,
        };

        info!(old=?old_tx_precursor, new=?new_gas_price, "estimated and escalated gas price for transaction");
        Ok(new_gas_price)
    }

    fn update_tx(&self, tx: &mut Transaction, nonce: Option<U256>, gas_price: GasPrice) {
        let precursor = tx.precursor_mut();

        if let GasPrice::Eip1559 {
            max_fee,
            max_priority_fee,
        } = gas_price
        {
            // Re-create the whole EIP-1559 transaction request in this case

            let tx = precursor.tx.clone();

            let mut request = Eip1559TransactionRequest::new();
            if let Some(from) = tx.from() {
                request = request.from(*from);
            }
            if let Some(to) = tx.to() {
                request = request.to(to.clone());
            }
            if let Some(data) = tx.data() {
                request = request.data(data.clone());
            }
            if let Some(value) = tx.value() {
                request = request.value(*value);
            }
            if let Some(nonce) = tx.nonce() {
                request = request.nonce(*nonce);
            }
            if let Some(gas_limit) = tx.gas() {
                request = request.gas(*gas_limit);
            }
            if let Some(chain_id) = tx.chain_id() {
                request = request.chain_id(chain_id);
            }
            request = request.max_fee_per_gas(max_fee);
            request = request.max_priority_fee_per_gas(max_priority_fee);

            let eip_1559_tx = TypedTransaction::Eip1559(request);
            precursor.tx = eip_1559_tx.clone();
        }

        match gas_price {
            GasPrice::None => {}
            GasPrice::NonEip1559 { gas_price } => {
                precursor.tx.set_gas_price(gas_price);
            }
            GasPrice::Eip1559 { .. } => {}
        }

        match nonce {
            None => {}
            Some(nonce) => {
                precursor.tx.set_nonce(nonce);
            }
        }

        info!(?tx, "updated transaction with nonce and gas price");
    }

    fn filter<I: Clone>(items: &[I], indices: Vec<usize>) -> Vec<I> {
        items
            .iter()
            .enumerate()
            .filter(|(index, _)| indices.contains(index))
            .map(|(_, item)| item.clone())
            .collect::<Vec<_>>()
    }

    async fn load_payloads(&self, tx: &Transaction) -> Result<Vec<FullPayload>, LanderError> {
        use itertools::{Either, Itertools};

        // while we are using RocksDB as the payload database, querying payloads by UUID will be
        // a blocking operation which becomes more and more expensive as the number of payloads
        // increases.
        let payload_futures = tx
            .payload_details
            .iter()
            .map(|p| async {
                self.payload_db
                    .retrieve_payload_by_uuid(&p.uuid)
                    .await
                    .map(|payload| (*p.uuid, payload))
            })
            .collect::<Vec<_>>();
        let payloads = future::try_join_all(payload_futures).await?;
        let (payloads, missing_uuids): (Vec<FullPayload>, Vec<Uuid>) = payloads
            .into_iter()
            .partition_map(|(uuid, payload)| match payload {
                Some(payload) => Either::Left(payload),
                None => Either::Right(uuid),
            });

        if !missing_uuids.is_empty() {
            error!(
                ?tx,
                ?missing_uuids,
                "Failed to find payloads in the database for transaction simulation"
            );
            return Err(LanderError::PayloadNotFound);
        }

        Ok(payloads)
    }

    fn create_precursors(&self, payloads: &[FullPayload]) -> Vec<EthereumTxPrecursor> {
        payloads
            .iter()
            .map(|p| EthereumTxPrecursor::from_payload(p, self.signer))
            .collect::<Vec<_>>()
    }

    fn extract_vm_specific_metrics(tx: &Transaction) -> PostInclusionMetricsSource {
        let mut metrics_source = PostInclusionMetricsSource::default();
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
        metrics_source.gas_limit = precursor.tx.gas().map(|g| g.as_u64());
        metrics_source
    }

    /// Helper to build a single transaction from a precursor and payload details.
    fn build_single_transaction(
        &self,
        precursor: EthereumTxPrecursor,
        payload_details: Vec<PayloadDetails>,
    ) -> TxBuildingResult {
        use super::transaction::TransactionFactory;
        let transaction = TransactionFactory::build(precursor, payload_details.clone());
        TxBuildingResult {
            payloads: payload_details,
            maybe_tx: Some(transaction),
        }
    }

    /// Helper to build a batched transaction from multiple precursors and payload details.
    async fn build_batched_transaction(
        &self,
        precursors: Vec<(TypedTransaction, Function)>,
        payload_details: Vec<PayloadDetails>,
    ) -> Vec<TxBuildingResult> {
        use super::transaction::TransactionFactory;

        let multi_precursor = self
            .provider
            .batch(
                self.batch_cache.clone(),
                self.batch_contract_address,
                precursors,
                self.signer,
            )
            .await
            .map(|(tx, f)| EthereumTxPrecursor::new(tx, f));

        let Ok(multi_precursor) = multi_precursor else {
            error!("Failed to batch payloads");
            return vec![];
        };

        let transaction = TransactionFactory::build(multi_precursor, payload_details.clone());

        let tx_building_result = TxBuildingResult {
            payloads: payload_details,
            maybe_tx: Some(transaction),
        };

        vec![tx_building_result]
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

    async fn tx_ready_for_resubmission(&self, tx: &Transaction) -> bool {
        let estimated_block_time = self.estimated_block_time();
        let ready_time = estimated_block_time.max(&self.minimum_time_between_resubmissions);

        let Some(last_submission_time) = tx.last_submission_attempt else {
            // If the transaction has never been submitted, it is ready for resubmission
            return true;
        };
        let elapsed = chrono::Utc::now() - last_submission_time;
        let elapsed = match elapsed.to_std() {
            Ok(duration) => duration,
            Err(err) => {
                warn!(
                    ?elapsed,
                    ?err,
                    "Failed to convert elapsed time to std::time::Duration, defaulting to considering the tx ready for resubmission"
                );
                return true;
            }
        };
        elapsed > *ready_time
    }

    /// Builds a transaction for the given payloads.
    ///
    /// If there is only one payload, it builds a transaction without batching.
    /// If there are multiple payloads, it batches them into a single transaction.
    /// The order of individual calls in the batched transaction is determined
    /// by the order of payloads.
    /// The order should not change since the simulation and estimation of the batched transaction
    /// depend on the order of payloads.
    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        use super::transaction::TransactionFactory;

        info!(?payloads, "building transactions for payloads");

        if payloads.is_empty() {
            error!("No payloads found! Cannot build transactions");
            return vec![];
        }

        let (payload_details, precursors): (
            Vec<PayloadDetails>,
            Vec<(TypedTransaction, Function)>,
        ) = payloads
            .iter()
            .map(|payload| {
                let precursor = EthereumTxPrecursor::from_payload(payload, self.signer);
                (payload.details.clone(), (precursor.tx, precursor.function))
            })
            .unzip();

        if precursors.len() == 1 {
            // If there's only one payload, we can build a single transaction directly
            let (tx, function) = precursors[0].clone();
            let precursor = EthereumTxPrecursor::new(tx, function);
            let results = vec![self.build_single_transaction(precursor, payload_details)];
            info!(
                ?payloads,
                ?results,
                "built transaction for a single payload"
            );
            return results;
        }

        // Batched transaction
        let results = self
            .build_batched_transaction(precursors, payload_details)
            .await;

        info!(?payloads, ?results, "built transaction for payloads");
        results
    }

    #[instrument(
        skip_all,
        name = "EthereumAdapter::simulate_tx",
        fields(tx_uuid = ?tx.uuid, tx_status = ?tx.status, payloads = ?tx.payload_details)
    )]
    async fn simulate_tx(&self, tx: &mut Transaction) -> Result<Vec<PayloadDetails>, LanderError> {
        if tx.payload_details.len() == 1 {
            // We assume simulation successful for transaction containing a single payload
            return Ok(vec![]);
        }

        // Batching case, simulate batch

        info!(?tx, "simulating transaction with batching");

        // Load payloads from the database first so that remote call of simulation is not wasted
        let payloads = self.load_payloads(tx).await?;

        let precursor = tx.precursor().clone();

        let (successful, failed) = self
            .provider
            .simulate_batch((precursor.tx, precursor.function))
            .await?;

        let payloads_successful = Self::filter(&payloads, successful);
        let payloads_details_failed = Self::filter(
            &tx.payload_details,
            failed.iter().map(|(i, _)| *i).collect(),
        );

        info!(
            ?payloads_successful,
            ?payloads_details_failed,
            "successful and failed payloads after simulation"
        );

        if payloads_successful.is_empty() {
            error!(
                ?payloads_successful,
                ?payloads_details_failed,
                ?failed,
                "Failed to build transaction for payloads, no successful payloads after simulation"
            );
            let reasons = failed
                .iter()
                .map(|(_, reason)| reason.to_string())
                .collect::<Vec<_>>();
            return Err(LanderError::SimulationFailed(reasons));
        }

        let tx_building_results = self.build_transactions(&payloads_successful).await;
        let Some(tx_building_result) = tx_building_results.first() else {
            error!(
                ?payloads_successful,
                ?payloads_details_failed,
                "Failed to build transaction for payloads, no transaction building result"
            );
            return Err(LanderError::SimulationFailed(vec![
                "no transaction building result".to_string(),
            ]));
        };

        let Some(transaction) = tx_building_result.maybe_tx.clone() else {
            error!(
                ?payloads_successful,
                ?payloads_details_failed,
                "Failed to build transaction for payloads, transaction was not built"
            );
            return Err(LanderError::SimulationFailed(vec![
                "transaction was not built".to_string(),
            ]));
        };

        info!(
            rebuilt_transaction = ?transaction,
            "rebuilt transaction after simulation"
        );

        tx.payload_details = transaction.payload_details;
        tx.vm_specific_data = transaction.vm_specific_data;

        info!(?tx, "updated transaction after simulation");

        Ok(payloads_details_failed)
    }

    async fn estimate_tx(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        if tx.precursor().tx.gas().is_some() {
            debug!(
                ?tx,
                "skipping gas limit estimation for transaction, as it was already estimated"
            );
            return Ok(());
        }

        if tx.payload_details.len() == 1 {
            // No batching, estimate gas limit for the single payload
            let precursor = tx.precursor_mut();
            return gas_limit_estimator::estimate_gas_limit(
                self.provider.clone(),
                precursor,
                &self.transaction_overrides,
                &self.domain,
                true,
            )
            .await;
        }

        // Batching case, estimate batch
        let payloads = self.load_payloads(tx).await?;
        let mut precursors = self.create_precursors(&payloads);

        let payload_estimate_futures = precursors
            .iter_mut()
            .map(|p| {
                gas_limit_estimator::estimate_gas_limit(
                    self.provider.clone(),
                    p,
                    &self.transaction_overrides,
                    &self.domain,
                    false,
                )
            })
            .collect::<Vec<_>>();
        future::try_join_all(payload_estimate_futures).await?;

        let multi_precursor = tx.precursor().clone();
        let multi_precursor = (multi_precursor.tx, multi_precursor.function);
        let precursors = precursors
            .into_iter()
            .map(|p| (p.tx, p.function))
            .collect::<Vec<_>>();

        let gas_limit = self
            .provider
            .estimate_batch(multi_precursor, precursors)
            .await?;

        tx.precursor_mut().tx.set_gas(gas_limit);

        Ok(())
    }

    async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        use super::transaction::Precursor;
        use LanderError::TxAlreadyExists;

        let tx_for_nonce = tx.clone();
        let tx_for_gas_price = tx.clone();

        let (nonce, gas_price) = try_join!(
            self.calculate_nonce(&tx_for_nonce),
            self.estimate_gas_price(&tx_for_gas_price)
        )?;

        self.update_tx(tx, nonce, gas_price);

        info!(?tx, "submitting transaction");

        let precursor = tx.precursor();

        let send_result = self.provider.send(&precursor.tx, &precursor.function).await;
        let hash = match send_result {
            Ok(hash) => hash,
            Err(e) => {
                return if e.to_string().contains(NONCE_TOO_LOW_ERROR) {
                    Err(TxAlreadyExists)
                } else {
                    Err(e.into())
                }
            }
        };

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
            .filter_map(|d| {
                EthereumTxPrecursor::from_success_criteria(d, self.signer).map(|p| (d, p))
            })
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

    fn update_vm_specific_metrics(&self, tx: &Transaction, metrics: &DispatcherMetrics) {
        let metrics_source = Self::extract_vm_specific_metrics(tx);
        metrics.set_post_inclusion_metrics(&metrics_source, self.domain.as_ref());
    }
}

#[cfg(test)]
pub use gas_limit_estimator::apply_estimate_buffer_to_ethers;

#[cfg(test)]
mod tests;
