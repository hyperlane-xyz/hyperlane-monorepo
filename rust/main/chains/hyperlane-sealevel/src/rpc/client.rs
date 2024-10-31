use base64::Engine;
use borsh::{BorshDeserialize, BorshSerialize};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_client::{
    nonblocking::rpc_client::RpcClient, rpc_config::RpcBlockConfig,
    rpc_config::RpcProgramAccountsConfig, rpc_config::RpcTransactionConfig, rpc_response::Response,
};
use solana_sdk::{
    account::Account,
    commitment_config::CommitmentConfig,
    hash::Hash,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signature, Signer},
    transaction::Transaction,
};
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, TransactionStatus, UiConfirmedBlock,
    UiReturnDataEncoding, UiTransactionReturnData,
};

use hyperlane_core::{ChainCommunicationError, ChainResult, U256};

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
    ) -> ChainResult<bool> {
        self.0
            .confirm_transaction_with_commitment(signature, commitment)
            .await
            .map(|ctx| ctx.value)
            .map_err(HyperlaneSealevelError::ClientError)
            .map_err(Into::into)
    }

    pub async fn get_account(&self, pubkey: &Pubkey) -> ChainResult<Account> {
        self.0
            .get_account(pubkey)
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    /// Simulates an Instruction that will return a list of AccountMetas.
    pub async fn get_account_metas(
        &self,
        payer: &Keypair,
        instruction: Instruction,
    ) -> ChainResult<Vec<AccountMeta>> {
        // If there's no data at all, default to an empty vec.
        let account_metas = self
            .simulate_instruction::<SimulationReturnData<Vec<SerializableAccountMeta>>>(
                payer,
                instruction,
            )
            .await?
            .map(|serializable_account_metas| {
                serializable_account_metas
                    .return_data
                    .into_iter()
                    .map(|serializable_account_meta| serializable_account_meta.into())
                    .collect()
            })
            .unwrap_or_else(Vec::new);

        Ok(account_metas)
    }

    pub async fn get_account_with_finalized_commitment(
        &self,
        pubkey: &Pubkey,
    ) -> ChainResult<Account> {
        self.get_account_option_with_finalized_commitment(pubkey)
            .await?
            .ok_or_else(|| ChainCommunicationError::from_other_str("Could not find account data"))
    }

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

    pub async fn get_balance(&self, pubkey: &Pubkey) -> ChainResult<U256> {
        let balance = self
            .0
            .get_balance(pubkey)
            .await
            .map_err(Into::<HyperlaneSealevelError>::into)
            .map_err(ChainCommunicationError::from)?;

        Ok(balance.into())
    }

    pub async fn get_block(&self, height: u64) -> ChainResult<UiConfirmedBlock> {
        let config = RpcBlockConfig {
            commitment: Some(CommitmentConfig::finalized()),
            max_supported_transaction_version: Some(0),
            ..Default::default()
        };
        self.0
            .get_block_with_config(height, config)
            .await
            .map_err(HyperlaneSealevelError::ClientError)
            .map_err(Into::into)
    }

    pub async fn get_block_height(&self) -> ChainResult<u32> {
        let height = self
            .0
            .get_block_height_with_commitment(CommitmentConfig::finalized())
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

    pub async fn get_transaction(
        &self,
        signature: &Signature,
    ) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta> {
        let config = RpcTransactionConfig {
            commitment: Some(CommitmentConfig::finalized()),
            ..Default::default()
        };
        self.0
            .get_transaction_with_config(signature, config)
            .await
            .map_err(HyperlaneSealevelError::ClientError)
            .map_err(Into::into)
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

    /// Simulates an instruction, and attempts to deserialize it into a T.
    /// If no return data at all was returned, returns Ok(None).
    /// If some return data was returned but deserialization was unsuccessful,
    /// an Err is returned.
    pub async fn simulate_instruction<T: BorshDeserialize + BorshSerialize>(
        &self,
        payer: &Keypair,
        instruction: Instruction,
    ) -> ChainResult<Option<T>> {
        let commitment = CommitmentConfig::finalized();
        let recent_blockhash = self
            .get_latest_blockhash_with_commitment(commitment)
            .await?;
        let transaction = Transaction::new_unsigned(Message::new_with_blockhash(
            &[instruction],
            Some(&payer.pubkey()),
            &recent_blockhash,
        ));
        let return_data = self.simulate_transaction(&transaction).await?;

        if let Some(return_data) = return_data {
            let bytes = match return_data.data.1 {
                UiReturnDataEncoding::Base64 => base64::engine::general_purpose::STANDARD
                    .decode(return_data.data.0)
                    .map_err(ChainCommunicationError::from_other)?,
            };

            let decoded_data =
                T::try_from_slice(bytes.as_slice()).map_err(ChainCommunicationError::from_other)?;

            return Ok(Some(decoded_data));
        }

        Ok(None)
    }

    async fn simulate_transaction(
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
