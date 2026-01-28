use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use tracing::debug;

use hyperlane_base::{settings::ChainConf, CoreMetrics};
use hyperlane_core::{ContractLocator, H256, H512};
use hyperlane_tron::{TronProvider, TronProviderForLander};

use crate::adapter::chains::tron::{
    conf::create_signer, precursor::Precursor, submit::submit_transaction,
};
use crate::{
    adapter::{chains::tron::TronTxPrecursor, AdaptsChain, GasLimit, TxBuildingResult},
    payload::PayloadDetails,
    transaction::Transaction,
    DispatcherMetrics, FullPayload, LanderError, TransactionStatus,
};

pub struct TronAdapter<P: TronProviderForLander> {
    pub provider: Arc<P>,
    pub estimated_block_time: Duration,
}

impl TronAdapter<TronProvider> {
    pub fn from_conf(
        conf: &ChainConf,
        metrics: &CoreMetrics,
        connection_conf: &hyperlane_tron::ConnectionConf,
    ) -> Result<Self, LanderError> {
        // We must have a signer if we want to land transactions.
        let signer = create_signer(conf)?;

        let locator = ContractLocator {
            domain: &conf.domain,
            address: H256::zero(),
        };

        let chain_info = conf.metrics_conf().chain;
        let client_metrics = metrics.client_metrics();

        let provider = TronProvider::new(
            connection_conf,
            &locator,
            Some(signer.clone()),
            client_metrics,
            chain_info,
        )?;

        Ok(Self {
            provider: Arc::new(provider),
            estimated_block_time: conf.estimated_block_time,
        })
    }
}

#[async_trait]
impl<P: TronProviderForLander> AdaptsChain for TronAdapter<P> {
    /// Simulates Payload and returns its gas limit. Called in the Building Stage (PayloadDispatcher)
    async fn estimate_gas_limit(
        &self,
        _payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError> {
        todo!()
    }

    /// Performs batching if available. Internally estimates gas limit for batch as well. Called in the Building Stage (PayloadDispatcher)
    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        // we only support single payload transactions for now
        payloads
            .iter()
            .map(|payload| {
                let tx = TronTxPrecursor::from_data(&payload.data)
                    .map(|cursor| Transaction::new(cursor, vec![payload.details.clone()]))
                    .ok();
                TxBuildingResult {
                    payloads: vec![payload.details.clone()],
                    maybe_tx: tx,
                }
            })
            .collect::<Vec<_>>()
    }

    /// Simulates a Transaction before submitting it for the first time. Called in the Inclusion Stage (PayloadDispatcher)
    async fn simulate_tx(&self, _tx: &mut Transaction) -> Result<Vec<PayloadDetails>, LanderError> {
        // Because Tron doesn't support multiple payloads per transaction yet, we assume successful simulation for all payloads.
        Ok(vec![])
    }

    /// Estimates a Transaction's gas limit. Called in the Inclusion Stage (PayloadDispatcher)
    /// Skips estimation if the Transaction has already been estimated
    async fn estimate_tx(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        let precursor = tx.precursor_mut();
        if precursor.tx.gas().is_some() {
            debug!(
                ?tx,
                "skipping gas limit estimation for transaction, as it was already estimated"
            );
            return Ok(());
        }

        let gas_limit = self
            .provider
            .estimate_gas(&precursor.tx)
            .await
            .map_err(|_| LanderError::EstimationFailed)?;
        precursor.tx.set_gas(gas_limit);

        Ok(())
    }

    /// Sets / escalates gas price, sets nonce / blockhash and broadcasts the Transaction. Even if broadcasting fails, the Transaction struct remains mutated with the new estimates. Called in the Inclusion Stage (PayloadDispatcher)
    async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        submit_transaction(&*self.provider, tx).await
    }

    async fn get_tx_hash_status(&self, hash: H512) -> Result<TransactionStatus, LanderError> {
        let receipt = self
            .provider
            .get_transaction_receipt(hash)
            .await
            .map_err(|err| LanderError::TxHashNotFound(err.to_string()))?;

        match receipt {
            None => Err(LanderError::TxHashNotFound(
                "Transaction not found".to_string(),
            )),
            Some(receipt) => {
                debug!(?receipt, "tx receipt");

                let block_number = receipt.block_number;
                let Some(block_number) = block_number else {
                    return Ok(TransactionStatus::Mempool);
                };
                let block_number = block_number.as_u64();
                let finalized_block = self.provider.get_finalized_block_number().await;
                match finalized_block {
                    Ok(finalized_block) => {
                        if finalized_block as u64 >= block_number {
                            Ok(TransactionStatus::Finalized)
                        } else {
                            Ok(TransactionStatus::Included)
                        }
                    }
                    Err(err) => {
                        tracing::warn!(
                            ?err,
                            "Error checking block finality. Assuming tx is in mempool since we got tx receipt"
                        );
                        Ok(TransactionStatus::Mempool)
                    }
                }
            }
        }
    }

    /// Uses BatchManager, returns any reverted Payload UUIDs sent in a Transaction.
    /// Called in the Finality Stage (PayloadDispatcher).
    async fn reverted_payloads(
        &self,
        tx: &Transaction,
    ) -> Result<Vec<PayloadDetails>, LanderError> {
        let payloads = tx
            .payload_details
            .iter()
            .filter_map(|x| x.success_criteria.clone().map(|data| (data, x)));

        let mut reverted = Vec::new();

        for (data, payload) in payloads {
            let precursor = TronTxPrecursor::from_data(&data)?;
            let success = self
                .provider
                .call::<bool>(&precursor.tx, &precursor.function)
                .await?;
            if !success {
                reverted.push(payload.clone());
            }
        }

        Ok(reverted)
    }

    /// Return true if the transaction can be resubmitted (such as by escalating the gas price). Called in the Inclusion Stage (PayloadDispatcher).
    /// Defaults to true, since most chains don't have special rules for tx resubmission.
    async fn tx_ready_for_resubmission(&self, tx: &Transaction) -> bool {
        let last_attempt = tx.last_submission_attempt.unwrap_or(tx.creation_timestamp);
        let elapsed = chrono::Utc::now()
            .signed_duration_since(last_attempt)
            .num_seconds();

        // Tron doesn't state what's a good time to wait before resubmitting a tx, but Tron finality is approx. 18 blocks
        // We use that as a heuristic for when to try resubmitting
        elapsed >= self.estimated_block_time.as_secs() as i64 * 18
    }

    /// Returns the estimated block time of the chain. Used for polling pending transactions. Called in the Inclusion and Finality Stages of the PayloadDispatcher
    fn estimated_block_time(&self) -> &Duration {
        &self.estimated_block_time
    }

    /// Update any metrics related to sent transactions, such as gas price, nonce, etc.
    fn update_vm_specific_metrics(&self, _tx: &Transaction, _metrics: &DispatcherMetrics) {}
}

#[cfg(test)]
mod tests;
