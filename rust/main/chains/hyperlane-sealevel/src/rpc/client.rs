use hyperlane_core::{ChainCommunicationError, ChainResult, U256};
use solana_client::{
    nonblocking::rpc_client::RpcClient, rpc_config::RpcProgramAccountsConfig,
    rpc_response::Response,
};
use solana_sdk::{
    account::Account, commitment_config::CommitmentConfig, hash::Hash, pubkey::Pubkey,
    signature::Signature, transaction::Transaction,
};
use solana_transaction_status::{TransactionStatus, UiTransactionReturnData};
use tracing::warn;

use crate::error::HyperlaneSealevelError;

pub struct SealevelRpcClient(RpcClient);

impl SealevelRpcClient {
    pub fn new(rpc_endpoint: String) -> Self {
        Self(RpcClient::new_with_commitment(
            rpc_endpoint,
            CommitmentConfig::processed(),
        ))
    }

    pub async fn confirm_transaction_with_commitment(
        &self,
        signature: &Signature,
        commitment: CommitmentConfig,
    ) -> bool {
        self.0
            .confirm_transaction_with_commitment(signature, commitment)
            .await
            .map_err(|err| warn!("Failed to confirm inbox process transaction: {}", err))
            .map(|ctx| ctx.value)
            .unwrap_or(false)
    }

    pub async fn get_account(&self, pubkey: &Pubkey) -> ChainResult<Account> {
        self.0
            .get_account(pubkey)
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    pub async fn get_account_with_finalized_commitment(
        &self,
        pubkey: &Pubkey,
    ) -> ChainResult<Account> {
        self.0
            .get_account_with_commitment(pubkey, CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value
            .ok_or_else(|| ChainCommunicationError::from_other_str("Could not find account data"))
    }

    pub async fn get_block_height(&self) -> ChainResult<u32> {
        let height = self
            .0
            .get_block_height()
            .await
            .map_err(ChainCommunicationError::from_other)?
            .try_into()
            // FIXME solana block height is u64...
            .expect("sealevel block height exceeds u32::MAX");
        Ok(height)
    }

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

    pub async fn get_signature_statuses(
        &self,
        signatures: &[Signature],
    ) -> ChainResult<Response<Vec<Option<TransactionStatus>>>> {
        self.0
            .get_signature_statuses(signatures)
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    pub async fn get_balance(&self, pubkey: &Pubkey) -> ChainResult<U256> {
        let balance = self
            .0
            .get_balance(pubkey)
            .await
            .map_err(Into::<HyperlaneSealevelError>::into)
            .map_err(ChainCommunicationError::from)?;

        Ok(balance.into())
    }

    pub async fn is_blockhash_valid(&self, hash: &Hash) -> ChainResult<bool> {
        self.0
            .is_blockhash_valid(hash, CommitmentConfig::processed())
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    pub async fn send_and_confirm_transaction(
        &self,
        transaction: &Transaction,
    ) -> ChainResult<Signature> {
        self.0
            .send_and_confirm_transaction(transaction)
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    pub async fn simulate_transaction(
        &self,
        transaction: &Transaction,
    ) -> ChainResult<Option<UiTransactionReturnData>> {
        let return_data = self
            .0
            .simulate_transaction(transaction)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value
            .return_data;

        Ok(return_data)
    }
}

impl std::fmt::Debug for SealevelRpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RpcClient { ... }")
    }
}
