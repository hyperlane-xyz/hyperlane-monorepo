use borsh::{BorshDeserialize, BorshSerialize};
use derive_new::new;
use hyperlane_core::ChainCommunicationError;
use solana_client::rpc_config::RpcProgramAccountsConfig;
use solana_sdk::account::Account;
use solana_sdk::instruction::AccountMeta;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::{
    commitment_config::CommitmentConfig, instruction::Instruction, signature::Signature,
    transaction::Transaction,
};
use solana_transaction_status::UiConfirmedBlock;
use std::{fmt::Debug, ops::Deref, sync::Arc};

use crate::client::SealevelTxCostEstimate;
use crate::{priority_fee::PriorityFeeOracle, SealevelKeypair, TransactionSubmitter};

use super::SealevelProvider;

use hyperlane_core::{
    rpc_clients::FallbackProvider, BlockInfo, ChainInfo, ChainResult, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, TxnInfo, H256, H512, U256,
};

/// Fallback provider for sealevel
#[derive(Clone, new)]
pub struct SealevelFallbackProvider {
    fallback_provider: FallbackProvider<SealevelProvider, SealevelProvider>,
}

impl SealevelFallbackProvider {
    /// Builds a transaction with estimated costs for a given instruction.
    pub async fn build_estimated_tx_for_instruction(
        &self,
        instruction: Instruction,
        payer: SealevelKeypair,
        tx_submitter: Arc<TransactionSubmitter>,
        priority_fee_oracle: Arc<PriorityFeeOracle>,
    ) -> ChainResult<Transaction> {
        self.fallback_provider
            .call(move |provider| {
                let instruction = instruction.clone();
                let payer = payer.clone();
                let tx_submitter = tx_submitter.clone();
                let priority_fee_oracle = priority_fee_oracle.clone();

                let future = async move {
                    provider
                        .rpc_client()
                        .build_estimated_tx_for_instruction(
                            instruction,
                            &payer,
                            &tx_submitter,
                            &priority_fee_oracle,
                        )
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// confirm transaction with given commitment
    pub async fn confirm_transaction_with_commitment(
        &self,
        signature: Signature,
        commitment: CommitmentConfig,
    ) -> ChainResult<bool> {
        self.fallback_provider
            .call(move |provider| {
                let signature = signature.clone();
                let commitment = commitment.clone();
                let future = async move {
                    provider
                        .rpc_client()
                        .confirm_transaction_with_commitment(&signature, commitment)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// Simulates an Instruction that will return a list of AccountMetas.
    pub async fn get_account_metas(
        &self,
        payer: SealevelKeypair,
        instruction: Instruction,
    ) -> ChainResult<Vec<AccountMeta>> {
        self.fallback_provider
            .call(move |provider| {
                let payer = payer.clone();
                let instruction = instruction.clone();
                let future = async move {
                    provider
                        .rpc_client()
                        .get_account_metas(&payer, instruction)
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
            .call(move |provider| {
                let pubkey = pubkey.clone();
                let future = async move {
                    provider
                        .rpc_client()
                        .get_account_with_finalized_commitment(&pubkey)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// get block
    pub async fn get_block(&self, slot: u64) -> ChainResult<UiConfirmedBlock> {
        self.fallback_provider
            .call(move |provider| {
                let future = async move { provider.rpc_client().get_block(slot).await };
                Box::pin(future)
            })
            .await
    }

    /// get program accounts with config
    pub async fn get_estimated_costs_for_instruction(
        &self,
        instruction: Instruction,
        payer: SealevelKeypair,
        tx_submitter: Arc<TransactionSubmitter>,
        priority_fee_oracle: Arc<PriorityFeeOracle>,
    ) -> ChainResult<SealevelTxCostEstimate> {
        self.fallback_provider
            .call(move |provider| {
                let instruction = instruction.clone();
                let payer = payer.clone();
                let tx_submitter = tx_submitter.clone();
                let priority_fee_oracle = priority_fee_oracle.clone();

                let future = async move {
                    provider
                        .rpc_client()
                        .get_estimated_costs_for_instruction(
                            instruction,
                            &payer,
                            &tx_submitter,
                            &priority_fee_oracle,
                        )
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// get account with finalized commitment
    pub async fn get_minimum_balance_for_rent_exemption(&self, len: usize) -> ChainResult<u64> {
        self.fallback_provider
            .call(move |provider| {
                let future = async move {
                    provider
                        .rpc_client()
                        .get_minimum_balance_for_rent_exemption(len)
                        .await
                };
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
            .call(move |provider| {
                let pubkey = pubkey.clone();

                let future = async move {
                    provider
                        .rpc_client()
                        .get_account_option_with_finalized_commitment(&pubkey)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// get multiple accounts with finalized commitment
    pub async fn get_multiple_accounts_with_finalized_commitment(
        &self,
        pubkeys: &[Pubkey],
    ) -> ChainResult<Vec<Option<Account>>> {
        let pubkeys_vec = pubkeys.to_vec();
        self.fallback_provider
            .call(move |provider| {
                let pubkeys = pubkeys_vec.clone();

                let future = async move {
                    provider
                        .rpc_client()
                        .get_multiple_accounts_with_finalized_commitment(pubkeys.as_slice())
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// Gets the estimated costs for a given instruction.
    pub async fn get_program_accounts_with_config(
        &self,
        pubkey: Pubkey,
        config: RpcProgramAccountsConfig,
    ) -> ChainResult<Vec<(Pubkey, Account)>> {
        self.fallback_provider
            .call(move |provider| {
                let pubkey = pubkey.clone();
                let config = config.clone();

                let future = async move {
                    provider
                        .rpc_client()
                        .get_program_accounts_with_config(&pubkey, config)
                        .await
                };
                Box::pin(future)
            })
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    /// get slot
    pub async fn get_slot(&self) -> ChainResult<u32> {
        self.fallback_provider
            .call(move |provider| {
                let future = async move { provider.rpc_client().get_slot().await };
                Box::pin(future)
            })
            .await
    }

    /// Simulates an instruction, and attempts to deserialize it into a T.
    /// If no return data at all was returned, returns Ok(None).
    /// If some return data was returned but deserialization was unsuccessful,
    /// an Err is returned.
    pub async fn simulate_instruction<T: BorshDeserialize + BorshSerialize>(
        &self,
        payer: SealevelKeypair,
        instruction: Instruction,
    ) -> ChainResult<Option<T>> {
        self.fallback_provider
            .call(move |provider| {
                let payer = payer.clone();
                let instruction = instruction.clone();
                let future = async move {
                    provider
                        .rpc_client()
                        .simulate_instruction(&payer, instruction)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// Polls the RPC until the transaction is confirmed or the blockhash
    /// expires.
    /// Standalone logic stolen from Solana's non-blocking client,
    /// decoupled from the sending of a transaction.
    pub async fn wait_for_transaction_confirmation(&self, tx: Transaction) -> ChainResult {
        self.fallback_provider
            .call(move |provider| {
                let tx = tx.clone();
                let future = async move {
                    provider
                        .rpc_client()
                        .wait_for_transaction_confirmation(&tx)
                        .await
                };
                Box::pin(future)
            })
            .await?;
        Ok(())
    }
}

impl Debug for SealevelFallbackProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "SealevelFallbackProvider {{ count: {} }}",
            self.fallback_provider.len()
        )
    }
}

impl Deref for SealevelFallbackProvider {
    type Target = FallbackProvider<SealevelProvider, SealevelProvider>;

    fn deref(&self) -> &Self::Target {
        &self.fallback_provider
    }
}

impl HyperlaneChain for SealevelFallbackProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.fallback_provider.inner.providers[0].domain
    }
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait::async_trait]
impl HyperlaneProvider for SealevelFallbackProvider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        self.fallback_provider
            .call(move |provider| {
                let future = async move { provider.get_block_by_height(height).await };
                Box::pin(future)
            })
            .await
    }

    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        self.fallback_provider
            .call(move |provider| {
                let hash = hash.clone();
                let future = async move { provider.get_txn_by_hash(&hash).await };
                Box::pin(future)
            })
            .await
    }

    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        self.fallback_provider
            .call(move |provider| {
                let address = address.clone();
                let future = async move { provider.is_contract(&address).await };
                Box::pin(future)
            })
            .await
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        self.fallback_provider
            .call(move |provider| {
                let address = address.clone();
                let future = async move { provider.get_balance(address).await };
                Box::pin(future)
            })
            .await
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        self.fallback_provider
            .call(move |provider| {
                let future = async move { provider.get_chain_metrics().await };
                Box::pin(future)
            })
            .await
    }
}
