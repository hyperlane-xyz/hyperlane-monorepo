use std::sync::Arc;

use async_trait::async_trait;
use eyre::{bail, ContextCompat, Report, Result};
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
use tracing::{info, warn};
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
use hyperlane_core::{ChainResult, ReorgPeriod, H256};
use hyperlane_sealevel::fallback::{SealevelFallbackRpcClient, SubmitSealevelRpc};
use hyperlane_sealevel::{
    PriorityFeeOracleConfig, SealevelProvider, SealevelProviderForSubmitter, SealevelTxCostEstimate,
};

use crate::chain_tx_adapter::chains::sealevel::conf::{create_keypair, get_connection_conf};
use crate::chain_tx_adapter::chains::sealevel::transaction::{
    Precursor, TransactionFactory, Update,
};
use crate::chain_tx_adapter::chains::sealevel::SealevelTxPrecursor;
use crate::chain_tx_adapter::{AdaptsChain, GasLimit};
use crate::payload::{FullPayload, VmSpecificPayloadData};
use crate::transaction::{
    SignerAddress, Transaction, TransactionId, TransactionStatus, VmSpecificTxData,
};

pub struct SealevelTxAdapter {
    reorg_period: ReorgPeriod,
    keypair: SealevelKeypair,
    client: Box<dyn SubmitSealevelRpc>,
    provider: Box<dyn SealevelProviderForSubmitter>,
    oracle: Box<dyn PriorityFeeOracle>,
    submitter: Box<dyn TransactionSubmitter>,
}

impl SealevelTxAdapter {
    pub fn new(conf: ChainConf, raw_conf: RawChainConf, metrics: &CoreMetrics) -> Result<Self> {
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
        provider: Box<dyn SealevelProviderForSubmitter>,
        oracle: Box<dyn PriorityFeeOracle>,
        submitter: Box<dyn TransactionSubmitter>,
    ) -> Result<Self> {
        let keypair = create_keypair(&conf)?;
        let reorg_period = conf.reorg_period.clone();

        Ok(Self {
            reorg_period,
            keypair,
            provider,
            client,
            oracle,
            submitter,
        })
    }

    #[allow(unused)]
    #[cfg(test)]
    fn new_internal_default(
        client: Box<dyn SubmitSealevelRpc>,
        provider: Box<dyn SealevelProviderForSubmitter>,
        oracle: Box<dyn PriorityFeeOracle>,
        submitter: Box<dyn TransactionSubmitter>,
    ) -> Self {
        Self {
            reorg_period: ReorgPeriod::default(),
            keypair: SealevelKeypair::default(),
            provider,
            client,
            oracle,
            submitter,
        }
    }

    async fn estimate(&self, precursor: SealevelTxPrecursor) -> ChainResult<SealevelTxPrecursor> {
        let estimate = self
            .provider
            .get_estimated_costs_for_instruction(
                precursor.instruction.clone(),
                &self.keypair,
                &*self.submitter,
                &*self.oracle,
            )
            .await?;
        Ok(SealevelTxPrecursor::new(precursor.instruction, estimate))
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
}

#[async_trait]
impl AdaptsChain for SealevelTxAdapter {
    async fn estimate_gas_limit(&self, payload: &FullPayload) -> Result<GasLimit> {
        info!(?payload, "estimating payload");
        let not_estimated = SealevelTxPrecursor::from_payload(payload);
        let estimated = self.estimate(not_estimated).await?;
        info!(?payload, ?estimated, "estimated payload");
        Ok(estimated.estimate.compute_units.into())
    }

    async fn build_transactions(&self, payloads: &[FullPayload]) -> Result<Vec<Transaction>> {
        info!(?payloads, "building transactions for payloads");
        let payloads_and_precursors = payloads
            .iter()
            .map(|payload| (SealevelTxPrecursor::from_payload(payload), payload))
            .collect::<Vec<(SealevelTxPrecursor, &FullPayload)>>();

        let mut transactions = Vec::new();
        for (not_estimated, payload) in payloads_and_precursors.into_iter() {
            let estimated = self.estimate(not_estimated).await?;
            let transaction = TransactionFactory::build(payload, estimated);
            transactions.push(transaction);
        }

        info!(?payloads, ?transactions, "built transactions for payloads");
        Ok(transactions)
    }

    async fn simulate_tx(&self, tx: &Transaction) -> Result<bool> {
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

    async fn submit(&self, tx: &mut Transaction) -> Result<()> {
        info!(?tx, "submitting transaction");
        let not_estimated = tx.precursor();
        let estimated = self.estimate(not_estimated.clone()).await?;
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

        let executed = self
            .submitter
            .confirm_transaction(signature, CommitmentConfig::processed())
            .await
            .map_err(|err| {
                warn!(
                    "Failed to confirm process transaction with commitment level processed: {}",
                    err
                )
            })
            .unwrap_or(false);

        info!(?tx, "confirmed transaction with commitment level processed");

        if !executed {
            bail!("Process transaction is not confirmed with commitment level processed")
        }

        Ok(())
    }

    async fn tx_status(&self, tx: &Transaction) -> Result<TransactionStatus> {
        info!(?tx, "checking status of transaction");

        let h512 = tx.hash().ok_or(eyre::eyre!(
            "Hash should be set for transaction to check its status"
        ))?;
        let signature = Signature::new(h512.as_ref());
        let transaction_search_result = self.client.get_transaction(signature).await;

        let transaction = if let Ok(transaction) = transaction_search_result {
            transaction
        } else {
            info!(?tx, "pending transaction");
            return Ok(TransactionStatus::PendingInclusion);
        };

        // slot at which transaction was included into blockchain
        let inclusion_slot = transaction.slot;

        info!(?tx, slot = ?inclusion_slot, "found transaction");

        // if block with this slot is added to the chain, transaction is considered to be confirmed
        let confirming_slot = inclusion_slot + self.reorg_period.as_blocks()? as u64;

        let confirming_block = self.client.get_block(confirming_slot).await;

        if confirming_block.is_ok() {
            info!(?tx, "finalized transaction");
            return Ok(TransactionStatus::Finalized);
        }

        // block which includes transaction into blockchain
        let including_block = self.client.get_block(inclusion_slot).await;

        match including_block {
            Ok(_) => {
                info!(?tx, "included transaction");
                Ok(TransactionStatus::Included)
            }
            Err(_) => {
                info!(?tx, "pending transaction");
                Ok(TransactionStatus::PendingInclusion)
            }
        }
    }

    async fn reverted_payloads(&self, _tx: &Transaction) -> Result<Vec<Uuid>> {
        // Dummy implementation of reverted payloads for Sealevel since we don't have batching for Sealevel
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests;
