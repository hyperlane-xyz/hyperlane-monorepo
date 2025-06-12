use std::{collections::HashMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::Utc;
use eyre::eyre;
use futures_util::future::join_all;
use serde_json::json;
use solana_client::rpc_response::{Response, RpcSimulateTransactionResult};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::AccountMeta,
    message::Message,
    pubkey::Pubkey,
    signature::{Signature, Signer},
    transaction::Transaction as SealevelTransaction,
};
use tokio::sync::Mutex;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use hyperlane_base::{
    settings::{
        parser::h_sealevel::{
            client_builder::SealevelRpcClientBuilder, ConnectionConf, PriorityFeeOracle,
            SealevelKeypair, TransactionSubmitter,
        },
        BuildableWithSignerConf, ChainConf, ChainConnectionConf, RawChainConf, SignerConf,
    },
    CoreMetrics,
};
use hyperlane_core::{ChainResult, ReorgPeriod, H256, H512};
use hyperlane_sealevel::{
    fallback::{SealevelFallbackRpcClient, SubmitSealevelRpc},
    PriorityFeeOracleConfig, SealevelProvider, SealevelProviderForLander, SealevelTxCostEstimate,
};

use crate::{
    adapter::{
        chains::sealevel::{
            conf::{create_keypair, get_connection_conf},
            transaction::{Precursor, TransactionFactory, Update},
            SealevelTxPrecursor,
        },
        core::TxBuildingResult,
        AdaptsChain, GasLimit,
    },
    error,
    error::LanderError,
    payload::{FullPayload, PayloadDetails},
    transaction::{
        SignerAddress, Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData,
    },
    TransactionDropReason,
};

const TX_RESUBMISSION_MIN_DELAY_SECS: u64 = 15;

#[derive(Default, Clone, Copy, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum EstimateFreshnessCache {
    #[default]
    Stale,
    Fresh,
}

pub struct SealevelAdapter {
    estimated_block_time: Duration,
    max_batch_size: u32,
    keypair: SealevelKeypair,
    client: Box<dyn SubmitSealevelRpc>,
    provider: Box<dyn SealevelProviderForLander>,
    oracle: Box<dyn PriorityFeeOracle>,
    submitter: Box<dyn TransactionSubmitter>,
    estimate_freshness_cache: Arc<Mutex<HashMap<TransactionUuid, EstimateFreshnessCache>>>,
}

impl SealevelAdapter {
    pub fn new(
        conf: ChainConf,
        raw_conf: RawChainConf,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Self> {
        let connection_conf = get_connection_conf(&conf);
        let urls = &connection_conf.urls;
        let chain_info = conf.metrics_conf().chain;
        let client_metrics = metrics.client_metrics();

        let client = SealevelFallbackRpcClient::from_urls(
            chain_info.clone(),
            urls.clone(),
            client_metrics.clone(),
        );

        let provider = SealevelProvider::new(
            client.clone(),
            conf.domain.clone(),
            &[H256::zero()],
            connection_conf,
        );

        let oracle = connection_conf.priority_fee_oracle.create_oracle();

        let submitter = connection_conf.transaction_submitter.create_submitter(
            &Arc::new(provider.clone()),
            client_metrics.clone(),
            chain_info.clone(),
            conf.domain.clone(),
            connection_conf,
        );

        Self::new_internal(
            conf,
            raw_conf,
            Box::new(client),
            Box::new(provider),
            oracle,
            submitter,
        )
    }

    fn new_internal(
        conf: ChainConf,
        _raw_conf: RawChainConf,
        client: Box<dyn SubmitSealevelRpc>,
        provider: Box<dyn SealevelProviderForLander>,
        oracle: Box<dyn PriorityFeeOracle>,
        submitter: Box<dyn TransactionSubmitter>,
    ) -> eyre::Result<Self> {
        let estimated_block_time = conf.estimated_block_time;
        let max_batch_size = Self::batch_size(&conf)?;
        let keypair = create_keypair(&conf)?;
        let estimate_freshness_cache = Arc::new(Mutex::new(HashMap::new()));

        Ok(Self {
            estimated_block_time,
            max_batch_size,
            keypair,
            provider,
            client,
            oracle,
            submitter,
            estimate_freshness_cache,
        })
    }

    #[allow(unused)]
    #[cfg(test)]
    fn new_internal_default(
        client: Box<dyn SubmitSealevelRpc>,
        provider: Box<dyn SealevelProviderForLander>,
        oracle: Box<dyn PriorityFeeOracle>,
        submitter: Box<dyn TransactionSubmitter>,
    ) -> Self {
        Self {
            estimated_block_time: Duration::from_secs(1),
            max_batch_size: 1,
            keypair: SealevelKeypair::default(),
            provider,
            client,
            oracle,
            submitter,
            estimate_freshness_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn batch_size(conf: &ChainConf) -> eyre::Result<u32> {
        Ok(conf
            .connection
            .operation_submission_config()
            .ok_or_else(|| eyre!("no operation batch config"))?
            .max_batch_size)
    }

    async fn estimate(
        &self,
        precursor: &SealevelTxPrecursor,
    ) -> Result<SealevelTxPrecursor, LanderError> {
        let estimate = self
            .provider
            .get_estimated_costs_for_instruction(
                precursor.instruction.clone(),
                &self.keypair,
                &*self.submitter,
                &*self.oracle,
            )
            .await?;
        Ok(SealevelTxPrecursor::new(
            precursor.instruction.clone(),
            estimate,
        ))
    }

    async fn create_unsigned_transaction(
        &self,
        precursor: &SealevelTxPrecursor,
    ) -> ChainResult<SealevelTransaction> {
        self.create_sealevel_transaction(precursor, false).await
    }

    async fn create_signed_transaction(
        &self,
        precursor: &SealevelTxPrecursor,
    ) -> ChainResult<SealevelTransaction> {
        self.create_sealevel_transaction(precursor, true).await
    }

    async fn create_sealevel_transaction(
        &self,
        precursor: &SealevelTxPrecursor,
        sign: bool,
    ) -> ChainResult<SealevelTransaction> {
        let SealevelTxPrecursor {
            instruction,
            estimate,
        } = precursor;

        self.provider
            .create_transaction_for_instruction(
                estimate.compute_units,
                estimate.compute_unit_price_micro_lamports,
                instruction.clone(),
                &self.keypair,
                &*self.submitter,
                sign,
            )
            .await
    }

    #[instrument(skip(self))]
    async fn get_tx_hash_status(&self, tx_hash: H512) -> Result<TransactionStatus, LanderError> {
        let signature = Signature::new(tx_hash.as_ref());

        // query the tx hash from most to least finalized to learn what level of finality it has
        // the calls below can be parallelized if needed, but for now avoid rate limiting

        if self
            .client
            .get_transaction_with_commitment(signature, CommitmentConfig::finalized())
            .await
            .is_ok()
        {
            info!("transaction finalized");
            return Ok(TransactionStatus::Finalized);
        }

        // the "confirmed" commitment is equivalent to being "included" in a block on evm
        if self
            .client
            .get_transaction_with_commitment(signature, CommitmentConfig::confirmed())
            .await
            .is_ok()
        {
            info!("transaction included");
            return Ok(TransactionStatus::Included);
        }

        match self
            .client
            .get_transaction_with_commitment(signature, CommitmentConfig::processed())
            .await
        {
            Ok(_) => {
                info!("transaction pending inclusion");
                return Ok(TransactionStatus::PendingInclusion);
            }
            Err(err) => {
                warn!(?err, "Failed to get transaction status by hash");
                return Err(LanderError::TxHashNotFound(err.to_string()));
            }
        }
    }
}

#[async_trait]
impl AdaptsChain for SealevelAdapter {
    async fn estimate_gas_limit(
        &self,
        payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError> {
        info!(?payload, "estimating payload");
        let not_estimated = SealevelTxPrecursor::from_payload(payload);
        let estimated = self.estimate(&not_estimated).await?;
        info!(?payload, ?estimated, "estimated payload");
        Ok(Some(estimated.estimate.compute_units.into()))
    }

    async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult> {
        info!(?payloads, "building transactions for payloads");
        let payloads_and_precursors = payloads
            .iter()
            .map(|payload| (SealevelTxPrecursor::from_payload(payload), payload))
            .collect::<Vec<(SealevelTxPrecursor, &FullPayload)>>();

        let mut transactions = Vec::new();
        for (not_estimated, payload) in payloads_and_precursors.into_iter() {
            // We are not estimating transaction here since we will estimate it just before submission
            let transaction = TransactionFactory::build(payload, not_estimated);
            transactions.push(TxBuildingResult::new(
                vec![payload.details.clone()],
                Some(transaction),
            ))
        }

        info!(?payloads, ?transactions, "built transactions for payloads");
        transactions
    }

    async fn simulate_tx(&self, tx: &Transaction) -> Result<bool, LanderError> {
        info!(?tx, "simulating transaction");
        let precursor = tx.precursor();
        let svm_transaction = self.create_unsigned_transaction(precursor).await?;
        let success = self
            .client
            .simulate_transaction(&svm_transaction)
            .await
            .is_ok();
        info!(?tx, success, "simulated transaction");
        Ok(success)
    }

    async fn estimate_tx(
        &self,
        tx: &mut Transaction,
        _skip_if_already_estimated: bool,
    ) -> Result<(), LanderError> {
        use EstimateFreshnessCache::{Fresh, Stale};

        info!(?tx, "estimating transaction");
        let not_estimated = tx.precursor();
        let estimated = self.estimate(not_estimated).await?;

        // If cache does not contain estimate type, insert Simulation type so that it can be used on the first submission
        {
            let mut guard = self.estimate_freshness_cache.lock().await;
            if guard.get(&tx.uuid).copied().unwrap_or_default() == Stale {
                guard.insert(tx.uuid.clone(), Fresh);
            }
        };

        tx.vm_specific_data = VmSpecificTxData::Svm(estimated);
        info!(?tx, "estimated transaction");
        Ok(())
    }

    async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        use EstimateFreshnessCache::{Fresh, Stale};

        info!(?tx, "submitting transaction");

        let previous = tx.precursor();
        let estimated = {
            let mut guard = self.estimate_freshness_cache.lock().await;
            match guard.get(&tx.uuid).copied().unwrap_or_default() {
                Stale => self.estimate(previous).await?,
                Fresh => {
                    guard.insert(tx.uuid.clone(), Stale);
                    previous.clone()
                }
            }
        };

        let svm_transaction = self.create_signed_transaction(&estimated).await?;
        let signature = self
            .submitter
            .send_transaction(&svm_transaction, true)
            .await?;

        let hash = signature.into();
        tx.update_after_submission(hash, estimated);

        info!(?tx, "submitted transaction");

        self.submitter
            .wait_for_transaction_confirmation(&svm_transaction)
            .await?;

        info!(?tx, "confirmed transaction by signature status");

        Ok(())
    }

    async fn get_tx_hash_status(&self, hash: H512) -> Result<TransactionStatus, LanderError> {
        info!(?hash, "getting transaction hash status");
        let status = self.get_tx_hash_status(hash).await?;
        info!(?hash, ?status, "got transaction hash status");
        Ok(status)
    }

    async fn tx_ready_for_resubmission(&self, tx: &Transaction) -> bool {
        if let Some(ref last_submission_time) = tx.last_submission_attempt {
            let seconds_since_last_submission =
                (Utc::now() - last_submission_time).num_seconds() as u64;
            return seconds_since_last_submission >= TX_RESUBMISSION_MIN_DELAY_SECS;
        }
        true
    }

    fn estimated_block_time(&self) -> &Duration {
        &self.estimated_block_time
    }

    fn max_batch_size(&self) -> u32 {
        self.max_batch_size
    }
}

#[cfg(test)]
mod tests;
