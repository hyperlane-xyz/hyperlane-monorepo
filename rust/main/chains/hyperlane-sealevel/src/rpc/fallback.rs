use std::fmt::Debug;

use async_trait::async_trait;
use derive_new::new;
use solana_client::rpc_config::RpcProgramAccountsConfig;
use solana_client::rpc_response::{Response, RpcSimulateTransactionResult};
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::hash::Hash;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_sdk::transaction::Transaction;
use solana_sdk::{account::Account, clock::Slot};
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, TransactionStatus, UiConfirmedBlock,
};
use url::Url;

use hyperlane_core::{rpc_clients::FallbackProvider, ChainResult, U256};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;

use crate::client::SealevelRpcClient;
use crate::client_builder::SealevelRpcClientBuilder;

/// Defines methods required to submit transactions to Sealevel chains
#[async_trait]
pub trait SubmitSealevelRpc: Send + Sync {
    /// Requests block from node
    async fn get_block(&self, slot: u64) -> ChainResult<UiConfirmedBlock>;

    /// Requests transaction from node
    async fn get_transaction(
        &self,
        signature: Signature,
    ) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta>;

    /// Simulates Sealevel transaction
    async fn simulate_transaction(
        &self,
        transaction: &Transaction,
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
    async fn get_block(&self, slot: u64) -> ChainResult<UiConfirmedBlock> {
        self.fallback_provider
            .call(move |client| {
                let future = async move { client.get_block(slot).await };
                Box::pin(future)
            })
            .await
    }

    /// get transaction
    async fn get_transaction(
        &self,
        signature: Signature,
    ) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta> {
        self.fallback_provider
            .call(move |client| {
                let signature = signature;
                let future = async move { client.get_transaction(&signature).await };
                Box::pin(future)
            })
            .await
    }

    /// simulate a transaction
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

    /// send transaction
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
