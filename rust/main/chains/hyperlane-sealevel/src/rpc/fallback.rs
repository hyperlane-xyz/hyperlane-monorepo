use std::fmt::Debug;

use async_trait::async_trait;
use derive_new::new;
use solana_client::rpc_config::RpcProgramAccountsConfig;
use solana_client::rpc_response::{
    Response, RpcConfirmedTransactionStatusWithSignature, RpcSimulateTransactionResult,
};
use solana_commitment_config::CommitmentConfig;
use solana_sdk::hash::Hash;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_sdk::transaction::{Transaction, VersionedTransaction};
use solana_sdk::{account::Account, clock::Slot};
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, TransactionConfirmationStatus, TransactionStatus,
    UiConfirmedBlock,
};
use url::Url;

use hyperlane_core::{
    rpc_clients::{FallbackProvider, RpcClientError},
    ChainCommunicationError, ChainResult, U256,
};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;

use crate::client::SealevelRpcClient;
use crate::client_builder::SealevelRpcClientBuilder;
use crate::tx_type::SealevelTxType;

fn validate_signature_status_response(
    response: Response<Vec<Option<TransactionStatus>>>,
    expected_len: usize,
) -> ChainResult<Response<Vec<Option<TransactionStatus>>>> {
    if response.value.len() != expected_len {
        return Err(ChainCommunicationError::from_other_str(&format!(
            "getSignatureStatuses returned {} statuses for {expected_len} signatures",
            response.value.len()
        )));
    }
    Ok(response)
}

fn signature_status_rank(status: &TransactionStatus) -> u8 {
    match status.confirmation_status() {
        TransactionConfirmationStatus::Processed => 0,
        TransactionConfirmationStatus::Confirmed => 1,
        TransactionConfirmationStatus::Finalized => 2,
    }
}

fn all_signature_statuses_finalized(
    signature_count: usize,
    responses: &[ChainResult<Response<Vec<Option<TransactionStatus>>>>],
) -> bool {
    (0..signature_count).all(|index| {
        responses.iter().any(|response| {
            response.as_ref().is_ok_and(|response| {
                response.value[index].as_ref().is_some_and(|status| {
                    status.confirmation_status() == TransactionConfirmationStatus::Finalized
                })
            })
        })
    })
}

fn merge_signature_status_responses(
    signature_count: usize,
    responses: Vec<ChainResult<Response<Vec<Option<TransactionStatus>>>>>,
) -> Vec<ChainResult<Option<TransactionStatus>>> {
    let mut statuses = vec![None; signature_count];
    let mut errors = Vec::new();

    for response in responses {
        match response {
            Ok(response) => {
                for (current, candidate) in statuses.iter_mut().zip(response.value) {
                    let should_replace = candidate.as_ref().is_some_and(|candidate| {
                        current.as_ref().is_none_or(|current| {
                            let candidate_rank = signature_status_rank(candidate);
                            let current_rank = signature_status_rank(current);
                            candidate_rank > current_rank
                                || (candidate_rank == current_rank && candidate.slot > current.slot)
                        })
                    });
                    if should_replace {
                        *current = candidate;
                    }
                }
            }
            Err(error) => errors.push(error),
        }
    }

    let fallback_error =
        (!errors.is_empty()).then(|| RpcClientError::FallbackProvidersFailed(errors).to_string());
    statuses
        .into_iter()
        .map(|status| match (status, &fallback_error) {
            (Some(status), _) => Ok(Some(status)),
            (None, None) => Ok(None),
            (None, Some(error)) => Err(ChainCommunicationError::from_other_str(error)),
        })
        .collect()
}

/// Defines methods required to submit transactions to Sealevel chains
#[async_trait]
pub trait SubmitSealevelRpc: Send + Sync {
    /// Requests block from node
    async fn get_block(&self, slot: u64) -> ChainResult<UiConfirmedBlock> {
        self.get_block_with_commitment(slot, CommitmentConfig::finalized())
            .await
    }

    /// Requests block from node, with a specific commitment
    async fn get_block_with_commitment(
        &self,
        slot: u64,
        commitment: CommitmentConfig,
    ) -> ChainResult<UiConfirmedBlock>;

    /// Requests transaction from node
    async fn get_transaction(
        &self,
        signature: Signature,
    ) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta> {
        self.get_transaction_with_commitment(signature, CommitmentConfig::finalized())
            .await
    }

    /// Requests transaction from node, with a specific commitment
    async fn get_transaction_with_commitment(
        &self,
        signature: Signature,
        commitment: CommitmentConfig,
    ) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta>;

    /// Requests transaction statuses from recent and rooted history.
    /// Returns exactly one result per input signature so a provider failure only
    /// marks unresolved entries as ambiguous.
    async fn get_signature_statuses_with_history(
        &self,
        signatures: &[Signature],
    ) -> Vec<ChainResult<Option<TransactionStatus>>>;

    /// Simulates Sealevel legacy transaction
    async fn simulate_transaction(
        &self,
        transaction: &Transaction,
    ) -> ChainResult<RpcSimulateTransactionResult>;

    /// Simulates Sealevel versioned transaction
    async fn simulate_versioned_transaction(
        &self,
        transaction: &VersionedTransaction,
    ) -> ChainResult<RpcSimulateTransactionResult>;
}

/// Fallback provider for sealevel
#[derive(Clone, new)]
pub struct SealevelFallbackRpcClient {
    fallback_provider: FallbackProvider<SealevelRpcClient, SealevelRpcClient>,
}

#[async_trait]
impl SubmitSealevelRpc for SealevelFallbackRpcClient {
    /// get block
    async fn get_block_with_commitment(
        &self,
        slot: u64,
        commitment: CommitmentConfig,
    ) -> ChainResult<UiConfirmedBlock> {
        self.fallback_provider
            .call(move |client| {
                let future =
                    async move { client.get_block_with_commitment(slot, commitment).await };
                Box::pin(future)
            })
            .await
    }

    /// get transaction
    async fn get_transaction_with_commitment(
        &self,
        signature: Signature,
        commitment: CommitmentConfig,
    ) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta> {
        self.fallback_provider
            .call(move |client| {
                let signature = signature;
                let future = async move {
                    client
                        .get_transaction_with_commitment(&signature, commitment)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    async fn get_signature_statuses_with_history(
        &self,
        signatures: &[Signature],
    ) -> Vec<ChainResult<Option<TransactionStatus>>> {
        SealevelFallbackRpcClient::get_signature_statuses_with_history(self, signatures).await
    }

    /// simulate a legacy transaction
    async fn simulate_transaction(
        &self,
        transaction: &Transaction,
    ) -> ChainResult<RpcSimulateTransactionResult> {
        self.fallback_provider
            .call(move |client| {
                let transaction = transaction.clone();
                let future = async move { client.simulate_transaction(&transaction).await };
                Box::pin(future)
            })
            .await
    }

    /// simulate a versioned transaction
    async fn simulate_versioned_transaction(
        &self,
        transaction: &VersionedTransaction,
    ) -> ChainResult<RpcSimulateTransactionResult> {
        self.fallback_provider
            .call(move |client| {
                let transaction = transaction.clone();
                let future =
                    async move { client.simulate_versioned_transaction(&transaction).await };
                Box::pin(future)
            })
            .await
    }
}

impl SealevelFallbackRpcClient {
    /// Create a SealevelFallbackProvider from a list of urls
    pub fn from_urls(
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
        urls: Vec<Url>,
        metrics: PrometheusClientMetrics,
    ) -> Self {
        let clients: Vec<_> = urls
            .into_iter()
            .map(|rpc_url| {
                SealevelRpcClientBuilder::new(rpc_url)
                    .with_prometheus_metrics(metrics.clone(), chain.clone())
                    .build()
            })
            .collect();

        let fallback = FallbackProvider::new(clients);
        SealevelFallbackRpcClient::new(fallback)
    }

    /// confirm transaction with given commitment
    pub async fn confirm_transaction_with_commitment(
        &self,
        signature: Signature,
        commitment: CommitmentConfig,
    ) -> ChainResult<bool> {
        self.fallback_provider
            .call(move |client| {
                let signature = signature;
                let commitment = commitment;
                let future = async move {
                    client
                        .confirm_transaction_with_commitment(&signature, commitment)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// get balance
    pub async fn get_balance(&self, pubkey: Pubkey) -> ChainResult<U256> {
        self.fallback_provider
            .call(move |client| {
                let pubkey = pubkey;
                let future = async move { client.get_balance(&pubkey).await };
                Box::pin(future)
            })
            .await
    }

    /// get account with finalized commitment
    pub async fn get_account_with_finalized_commitment(
        &self,
        pubkey: Pubkey,
    ) -> ChainResult<Account> {
        self.fallback_provider
            .call(move |client| {
                let pubkey = pubkey;
                let future =
                    async move { client.get_account_with_finalized_commitment(&pubkey).await };
                Box::pin(future)
            })
            .await
    }

    /// get account option with finalized commitment
    pub async fn get_account_option_with_finalized_commitment(
        &self,
        pubkey: Pubkey,
    ) -> ChainResult<Option<Account>> {
        self.fallback_provider
            .call(move |client| {
                let pubkey = pubkey;
                let future = async move {
                    client
                        .get_account_option_with_finalized_commitment(&pubkey)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// get account option with a commitment
    pub async fn get_account_option_with_commitment(
        &self,
        pubkey: Pubkey,
        commitment: CommitmentConfig,
    ) -> ChainResult<Option<Account>> {
        self.fallback_provider
            .call(move |client| {
                let pubkey = pubkey;
                let future = async move {
                    client
                        .get_account_option_with_commitment(&pubkey, commitment)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// get latest block hash with commitment
    pub async fn get_latest_blockhash_with_commitment(
        &self,
        commitment: CommitmentConfig,
    ) -> ChainResult<Hash> {
        self.fallback_provider
            .call(move |client| {
                let commitment = commitment;
                let future = async move {
                    client
                        .get_latest_blockhash_with_commitment(commitment)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// get minimum balance for rent exemption
    pub async fn get_minimum_balance_for_rent_exemption(&self, len: usize) -> ChainResult<u64> {
        self.fallback_provider
            .call(move |client| {
                let future =
                    async move { client.get_minimum_balance_for_rent_exemption(len).await };
                Box::pin(future)
            })
            .await
    }

    /// get multiple accounts with finalized commitment
    pub async fn get_multiple_accounts_with_finalized_commitment(
        &self,
        pubkeys: &[Pubkey],
    ) -> ChainResult<Vec<Option<Account>>> {
        self.fallback_provider
            .call(move |client| {
                let pubkeys = pubkeys.to_vec();
                let future = async move {
                    client
                        .get_multiple_accounts_with_finalized_commitment(&pubkeys)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// get program accounts with config
    pub async fn get_program_accounts_with_config(
        &self,
        pubkey: Pubkey,
        config: RpcProgramAccountsConfig,
    ) -> ChainResult<Vec<(Pubkey, Account)>> {
        self.fallback_provider
            .call(move |client| {
                let pubkey = pubkey;
                let config = config.clone();
                let future = async move {
                    client
                        .get_program_accounts_with_config(&pubkey, config)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// get slot
    pub async fn get_slot(&self) -> ChainResult<u32> {
        self.fallback_provider
            .call(move |client| {
                let future = async move { client.get_slot().await };
                Box::pin(future)
            })
            .await
    }

    /// get slot
    pub async fn get_slot_raw(&self) -> ChainResult<Slot> {
        self.fallback_provider
            .call(move |client| {
                let future = async move { client.get_slot_raw().await };
                Box::pin(future)
            })
            .await
    }

    /// check if block hash is valid
    pub async fn is_blockhash_valid(&self, hash: Hash) -> ChainResult<bool> {
        self.fallback_provider
            .call(move |client| {
                let hash = hash;
                let future = async move { client.is_blockhash_valid(&hash).await };
                Box::pin(future)
            })
            .await
    }

    /// send legacy transaction
    pub async fn send_transaction(
        &self,
        transaction: &Transaction,
        skip_preflight: bool,
    ) -> ChainResult<Signature> {
        self.fallback_provider
            .call(move |client| {
                let transaction = transaction.clone();
                let future =
                    async move { client.send_transaction(&transaction, skip_preflight).await };
                Box::pin(future)
            })
            .await
    }

    /// send versioned transaction
    pub async fn send_versioned_transaction(
        &self,
        transaction: &VersionedTransaction,
        skip_preflight: bool,
    ) -> ChainResult<Signature> {
        self.fallback_provider
            .call(move |client| {
                let transaction = transaction.clone();
                let future = async move {
                    client
                        .send_versioned_transaction(&transaction, skip_preflight)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// Send a transaction (dispatches based on type).
    pub async fn send_sealevel_tx(
        &self,
        tx: &SealevelTxType,
        skip_preflight: bool,
    ) -> ChainResult<Signature> {
        match tx {
            SealevelTxType::Legacy(t) => self.send_transaction(t, skip_preflight).await,
            SealevelTxType::Versioned(t) => {
                self.send_versioned_transaction(t, skip_preflight).await
            }
        }
    }

    /// Simulate a transaction (dispatches based on type).
    pub async fn simulate_sealevel_tx(
        &self,
        tx: &SealevelTxType,
    ) -> ChainResult<RpcSimulateTransactionResult> {
        match tx {
            SealevelTxType::Legacy(t) => self.simulate_transaction(t).await,
            SealevelTxType::Versioned(t) => self.simulate_versioned_transaction(t).await,
        }
    }

    /// Returns up to `limit` transaction signatures that reference `address`.
    pub async fn get_signatures_for_address_with_limit(
        &self,
        address: Pubkey,
        limit: usize,
    ) -> ChainResult<Vec<RpcConfirmedTransactionStatusWithSignature>> {
        self.fallback_provider
            .call(move |client| {
                let future = async move {
                    client
                        .get_signatures_for_address_with_limit(&address, limit)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// get statuses based on signatures
    pub async fn get_signature_statuses(
        &self,
        signatures: &[Signature],
    ) -> ChainResult<Response<Vec<Option<TransactionStatus>>>> {
        self.fallback_provider
            .call(move |client| {
                let signatures = signatures.to_vec();
                let future = async move { client.get_signature_statuses(&signatures).await };
                Box::pin(future)
            })
            .await
    }

    /// Get signature statuses, including rooted transaction history.
    /// Resolved statuses survive partial fallback-provider failures; unresolved
    /// entries carry individual errors.
    pub async fn get_signature_statuses_with_history(
        &self,
        signatures: &[Signature],
    ) -> Vec<ChainResult<Option<TransactionStatus>>> {
        let signature_count = signatures.len();
        let responses = self
            .fallback_provider
            .call_until(
                move |client| {
                    let signatures = signatures.to_vec();
                    let future = async move {
                        let response = client
                            .get_signature_statuses_with_history(&signatures)
                            .await?;
                        validate_signature_status_response(response, signatures.len())
                    };
                    Box::pin(future)
                },
                |responses| all_signature_statuses_finalized(signature_count, responses),
            )
            .await;
        merge_signature_status_responses(signature_count, responses)
    }
}

impl Debug for SealevelFallbackRpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "SealevelFallbackProvider {{ count: {} }}",
            self.fallback_provider.len()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_client::rpc_response::RpcResponseContext;

    fn status(confirmation_status: TransactionConfirmationStatus) -> TransactionStatus {
        TransactionStatus {
            slot: 42,
            confirmations: None,
            status: Ok(()),
            err: None,
            confirmation_status: Some(confirmation_status),
        }
    }

    fn response(
        slot: u64,
        value: Vec<Option<TransactionStatus>>,
    ) -> Response<Vec<Option<TransactionStatus>>> {
        Response {
            context: RpcResponseContext::new(slot),
            value,
        }
    }

    #[test]
    fn signature_status_merge_uses_strongest_provider_result_per_index() {
        let merged = merge_signature_status_responses(
            2,
            vec![
                Ok(response(
                    10,
                    vec![None, Some(status(TransactionConfirmationStatus::Confirmed))],
                )),
                Ok(response(
                    11,
                    vec![
                        Some(status(TransactionConfirmationStatus::Finalized)),
                        Some(status(TransactionConfirmationStatus::Finalized)),
                    ],
                )),
            ],
        );

        assert!(merged.into_iter().all(|status| {
            status.unwrap().unwrap().confirmation_status()
                == TransactionConfirmationStatus::Finalized
        }));
    }

    #[test]
    fn finalized_completion_requires_every_signature() {
        let responses = vec![Ok(response(
            10,
            vec![
                Some(status(TransactionConfirmationStatus::Finalized)),
                Some(status(TransactionConfirmationStatus::Confirmed)),
            ],
        ))];
        assert!(!all_signature_statuses_finalized(2, &responses));

        let responses = vec![Ok(response(
            10,
            vec![
                Some(status(TransactionConfirmationStatus::Finalized)),
                Some(status(TransactionConfirmationStatus::Finalized)),
            ],
        ))];
        assert!(all_signature_statuses_finalized(2, &responses));
    }

    #[test]
    fn signature_status_merge_reports_ambiguous_absence() {
        let merged = merge_signature_status_responses(
            1,
            vec![
                Ok(response(10, vec![None])),
                Err(ChainCommunicationError::from_other_str("RPC unavailable")),
            ],
        );

        assert!(merged[0].is_err());
    }

    #[test]
    fn signature_status_merge_reports_absence_after_all_providers_agree() {
        let merged = merge_signature_status_responses(
            1,
            vec![Ok(response(10, vec![None])), Ok(response(11, vec![None]))],
        );

        assert!(matches!(merged.as_slice(), [Ok(None)]));
    }

    #[test]
    fn signature_status_merge_preserves_resolved_entries_with_provider_failure() {
        let merged = merge_signature_status_responses(
            3,
            vec![
                Ok(response(
                    10,
                    vec![
                        Some(status(TransactionConfirmationStatus::Finalized)),
                        Some(status(TransactionConfirmationStatus::Finalized)),
                        None,
                    ],
                )),
                Err(ChainCommunicationError::from_other_str("RPC unavailable")),
            ],
        );

        assert!(matches!(merged[0], Ok(Some(_))));
        assert!(matches!(merged[1], Ok(Some(_))));
        assert!(merged[2].is_err());
    }

    #[test]
    fn signature_status_response_rejects_wrong_cardinality() {
        let result = validate_signature_status_response(response(10, vec![None]), 2);

        assert!(result.is_err());
    }
}
