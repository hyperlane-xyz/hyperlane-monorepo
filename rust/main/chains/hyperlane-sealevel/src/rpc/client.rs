use std::sync::Arc;

use solana_client::{
    nonblocking::rpc_client::RpcClient,
    rpc_config::{
        RpcBlockConfig, RpcProgramAccountsConfig, RpcSendTransactionConfig,
        RpcSimulateTransactionConfig, RpcTransactionConfig,
    },
    rpc_response::{Response, RpcSimulateTransactionResult},
};
use solana_program::clock::Slot;
use solana_sdk::{
    account::Account, commitment_config::CommitmentConfig, hash::Hash, pubkey::Pubkey,
    signature::Signature, transaction::Transaction,
};
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, TransactionStatus, UiConfirmedBlock,
    UiTransactionEncoding,
};

use hyperlane_core::{rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult, U256};

use crate::error::HyperlaneSealevelError;

/// Wrapper struct around Solana's RpcClient
#[derive(Clone)]
pub struct SealevelRpcClient(Arc<RpcClient>);

impl SealevelRpcClient {
    /// constructor
    pub fn new(rpc_endpoint: String) -> Self {
        let rpc_client =
            RpcClient::new_with_commitment(rpc_endpoint, CommitmentConfig::processed());
        Self::from_rpc_client(Arc::new(rpc_client))
    }

    /// constructor with an rpc client
    pub fn from_rpc_client(rpc_client: Arc<RpcClient>) -> Self {
        Self(rpc_client)
    }

    /// Get Url
    pub fn url(&self) -> String {
        self.0.url()
    }

    /// confirm transaction with given commitment
    pub async fn confirm_transaction_with_commitment(
        &self,
        signature: &Signature,
        commitment: CommitmentConfig,
    ) -> ChainResult<bool> {
        self.0
            .confirm_transaction_with_commitment(signature, commitment)
            .await
            .map(|ctx| ctx.value)
            .map_err(Box::new)
            .map_err(HyperlaneSealevelError::ClientError)
            .map_err(Into::into)
    }

    /// get account with finalized commitment
    pub async fn get_account_with_finalized_commitment(
        &self,
        pubkey: &Pubkey,
    ) -> ChainResult<Account> {
        self.get_account_option_with_finalized_commitment(pubkey)
            .await?
            .ok_or_else(|| ChainCommunicationError::from_other_str("Could not find account data"))
    }

    /// get account option with finalized commitment
    pub async fn get_account_option_with_finalized_commitment(
        &self,
        pubkey: &Pubkey,
    ) -> ChainResult<Option<Account>> {
        let account = self
            .0
            .get_account_with_commitment(pubkey, CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value;
        Ok(account)
    }

    /// get balance
    pub async fn get_balance(&self, pubkey: &Pubkey) -> ChainResult<U256> {
        let balance = self
            .0
            .get_balance(pubkey)
            .await
            .map_err(Box::new)
            .map_err(Into::<HyperlaneSealevelError>::into)
            .map_err(ChainCommunicationError::from)?;

        Ok(balance.into())
    }

    /// get block with commitment
    pub async fn get_block_with_commitment(
        &self,
        slot: u64,
        commitment: CommitmentConfig,
    ) -> ChainResult<UiConfirmedBlock> {
        let config = RpcBlockConfig {
            commitment: Some(commitment),
            max_supported_transaction_version: Some(0),
            ..Default::default()
        };
        self.0
            .get_block_with_config(slot, config)
            .await
            .map_err(Box::new)
            .map_err(HyperlaneSealevelError::ClientError)
            .map_err(Into::into)
    }

    /// get block_height
    pub async fn get_block_height(&self) -> ChainResult<u64> {
        self.0
            .get_block_height()
            .await
            .map_err(Box::new)
            .map_err(HyperlaneSealevelError::ClientError)
            .map_err(Into::into)
    }

    /// get minimum balance for rent exemption
    pub async fn get_minimum_balance_for_rent_exemption(&self, len: usize) -> ChainResult<u64> {
        self.0
            .get_minimum_balance_for_rent_exemption(len)
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    /// get multiple accounts with finalized commitment
    pub async fn get_multiple_accounts_with_finalized_commitment(
        &self,
        pubkeys: &[Pubkey],
    ) -> ChainResult<Vec<Option<Account>>> {
        let accounts = self
            .0
            .get_multiple_accounts_with_commitment(pubkeys, CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value;

        Ok(accounts)
    }

    /// get latest block hash with commitment
    pub async fn get_latest_blockhash_with_commitment(
        &self,
        commitment: CommitmentConfig,
    ) -> ChainResult<Hash> {
        self.0
            .get_latest_blockhash_with_commitment(commitment)
            .await
            .map_err(ChainCommunicationError::from_other)
            .map(|(blockhash, _)| blockhash)
    }

    /// get program accounts with config
    pub async fn get_program_accounts_with_config(
        &self,
        pubkey: &Pubkey,
        config: RpcProgramAccountsConfig,
    ) -> ChainResult<Vec<(Pubkey, Account)>> {
        self.0
            .get_program_accounts_with_config(pubkey, config)
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    /// get statuses based on signatures
    pub async fn get_signature_statuses(
        &self,
        signatures: &[Signature],
    ) -> ChainResult<Response<Vec<Option<TransactionStatus>>>> {
        self.0
            .get_signature_statuses(signatures)
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    /// get slot
    pub async fn get_slot(&self) -> ChainResult<u32> {
        let slot = self
            .get_slot_raw()
            .await?
            .try_into()
            // FIXME solana block height is u64...
            .expect("sealevel block slot exceeds u32::MAX");
        Ok(slot)
    }

    /// get slot
    pub async fn get_slot_raw(&self) -> ChainResult<Slot> {
        self.0
            .get_slot_with_commitment(CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    /// get transaction
    pub async fn get_transaction_with_commitment(
        &self,
        signature: &Signature,
        commitment: CommitmentConfig,
    ) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta> {
        let config = RpcTransactionConfig {
            encoding: Some(UiTransactionEncoding::JsonParsed),
            commitment: Some(commitment),
            max_supported_transaction_version: Some(0),
        };
        self.0
            .get_transaction_with_config(signature, config)
            .await
            .map_err(Box::new)
            .map_err(HyperlaneSealevelError::ClientError)
            .map_err(Into::into)
    }

    /// check if block hash is valid
    pub async fn is_blockhash_valid(&self, hash: &Hash) -> ChainResult<bool> {
        self.0
            .is_blockhash_valid(hash, CommitmentConfig::processed())
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    /// send transaction
    pub async fn send_transaction(
        &self,
        transaction: &Transaction,
        skip_preflight: bool,
    ) -> ChainResult<Signature> {
        self.0
            .send_transaction_with_config(
                transaction,
                RpcSendTransactionConfig {
                    skip_preflight,
                    ..Default::default()
                },
            )
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    /// simulate a transaction
    pub async fn simulate_transaction(
        &self,
        transaction: &Transaction,
    ) -> ChainResult<RpcSimulateTransactionResult> {
        let result = self
            .0
            .simulate_transaction_with_config(
                transaction,
                RpcSimulateTransactionConfig {
                    sig_verify: false,
                    replace_recent_blockhash: true,
                    ..Default::default()
                },
            )
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value;

        Ok(result)
    }
}

impl std::fmt::Debug for SealevelRpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RpcClient {{ url: {} }}", self.0.url())
    }
}

#[async_trait::async_trait]
impl BlockNumberGetter for SealevelRpcClient {
    async fn get_block_number(&self) -> ChainResult<u64> {
        self.get_block_height().await
    }
}

#[cfg(test)]
mod tests;
