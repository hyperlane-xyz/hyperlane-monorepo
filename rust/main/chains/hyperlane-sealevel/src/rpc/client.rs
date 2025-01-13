use base64::Engine;
use borsh::{BorshDeserialize, BorshSerialize};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_client::{
    nonblocking::rpc_client::RpcClient,
    rpc_client::SerializableTransaction,
    rpc_config::{
        RpcBlockConfig, RpcProgramAccountsConfig, RpcSendTransactionConfig,
        RpcSimulateTransactionConfig, RpcTransactionConfig,
    },
    rpc_response::{Response, RpcSimulateTransactionResult},
};
use solana_sdk::{
    account::Account,
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    hash::Hash,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signature, Signer},
    transaction::Transaction,
};
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, TransactionStatus, UiConfirmedBlock,
    UiReturnDataEncoding, UiTransactionEncoding,
};

use hyperlane_core::{ChainCommunicationError, ChainResult, U256};

use crate::{
    error::HyperlaneSealevelError, priority_fee::PriorityFeeOracle,
    tx_submitter::TransactionSubmitter,
};

const COMPUTE_UNIT_MULTIPLIER_NUMERATOR: u32 = 11;
const COMPUTE_UNIT_MULTIPLIER_DENOMINATOR: u32 = 10;

const PRIORITY_FEE_MULTIPLIER_NUMERATOR: u64 = 110;
const PRIORITY_FEE_MULTIPLIER_DENOMINATOR: u64 = 100;

pub struct SealevelTxCostEstimate {
    compute_units: u32,
    compute_unit_price_micro_lamports: u64,
}

pub struct SealevelRpcClient(RpcClient);

impl SealevelRpcClient {
    /// The max amount of compute units for a transaction.
    const MAX_COMPUTE_UNITS: u32 = 1_400_000;

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

    pub async fn get_block(&self, slot: u64) -> ChainResult<UiConfirmedBlock> {
        let config = RpcBlockConfig {
            commitment: Some(CommitmentConfig::finalized()),
            max_supported_transaction_version: Some(0),
            ..Default::default()
        };
        self.0
            .get_block_with_config(slot, config)
            .await
            .map_err(HyperlaneSealevelError::ClientError)
            .map_err(Into::into)
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

    pub async fn get_slot(&self) -> ChainResult<u32> {
        let slot = self
            .0
            .get_slot_with_commitment(CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .try_into()
            // FIXME solana block height is u64...
            .expect("sealevel block slot exceeds u32::MAX");
        Ok(slot)
    }

    pub async fn get_transaction(
        &self,
        signature: &Signature,
    ) -> ChainResult<EncodedConfirmedTransactionWithStatusMeta> {
        let config = RpcTransactionConfig {
            encoding: Some(UiTransactionEncoding::JsonParsed),
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

    /// Polls the RPC until the transaction is confirmed or the blockhash
    /// expires.
    /// Standalone logic stolen from Solana's non-blocking client,
    /// decoupled from the sending of a transaction.
    pub async fn wait_for_transaction_confirmation(
        &self,
        transaction: &impl SerializableTransaction,
    ) -> ChainResult<()> {
        let signature = transaction.get_signature();

        const GET_STATUS_RETRIES: usize = usize::MAX;

        let recent_blockhash = if transaction.uses_durable_nonce() {
            self.get_latest_blockhash_with_commitment(CommitmentConfig::processed())
                .await?
        } else {
            *transaction.get_recent_blockhash()
        };

        for status_retry in 0..GET_STATUS_RETRIES {
            let signature_statuses: Response<Vec<Option<TransactionStatus>>> =
                self.get_signature_statuses(&[*signature]).await?;
            let signature_status = signature_statuses.value.first().cloned().flatten();
            match signature_status {
                Some(_) => return Ok(()),
                None => {
                    if !self.is_blockhash_valid(&recent_blockhash).await? {
                        // Block hash is not found by some reason
                        break;
                    } else if cfg!(not(test))
                        // Ignore sleep at last step.
                        && status_retry < GET_STATUS_RETRIES
                    {
                        // Retry twice a second
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        continue;
                    }
                }
            }
        }

        Err(ChainCommunicationError::from_other(
            solana_client::rpc_request::RpcError::ForUser(
                "unable to confirm transaction. \
                This can happen in situations such as transaction expiration \
                and insufficient fee-payer funds"
                    .to_string(),
            ),
        ))
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
        let simulation = self.simulate_transaction(&transaction).await?;

        if let Some(return_data) = simulation.return_data {
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

    /// Gets the estimated costs for a given instruction.
    pub async fn get_estimated_costs_for_instruction(
        &self,
        instruction: Instruction,
        payer: &Keypair,
        tx_submitter: &dyn TransactionSubmitter,
        priority_fee_oracle: &dyn PriorityFeeOracle,
    ) -> ChainResult<SealevelTxCostEstimate> {
        // Build a transaction that sets the max compute units and a dummy compute unit price.
        // This is used for simulation to get the actual compute unit limit. We set dummy values
        // for the compute unit limit and price because we want to include the instructions that
        // set these in the cost estimate.
        let simulation_tx = self
            .create_transaction_for_instruction(
                Self::MAX_COMPUTE_UNITS,
                0,
                instruction.clone(),
                payer,
                tx_submitter,
                false,
            )
            .await?;

        let simulation_result = self.simulate_transaction(&simulation_tx).await?;

        // If there was an error in the simulation result, return an error.
        if simulation_result.err.is_some() {
            tracing::error!(?simulation_result, "Got simulation result for transaction");
            return Err(ChainCommunicationError::from_other_str(
                format!("Error in simulation result: {:?}", simulation_result.err).as_str(),
            ));
        } else {
            tracing::debug!(?simulation_result, "Got simulation result for transaction");
        }

        // Get the compute units used in the simulation result, requiring
        // that it is greater than 0.
        let simulation_compute_units: u32 = simulation_result
            .units_consumed
            .unwrap_or_default()
            .try_into()
            .map_err(ChainCommunicationError::from_other)?;
        if simulation_compute_units == 0 {
            return Err(ChainCommunicationError::from_other_str(
                "Empty or zero compute units returned in simulation result",
            ));
        }

        // Bump the compute units to be conservative
        let simulation_compute_units = Self::MAX_COMPUTE_UNITS.min(
            (simulation_compute_units * COMPUTE_UNIT_MULTIPLIER_NUMERATOR)
                / COMPUTE_UNIT_MULTIPLIER_DENOMINATOR,
        );

        let mut priority_fee = priority_fee_oracle.get_priority_fee(&simulation_tx).await?;

        if let Ok(max_priority_fee) = std::env::var("SVM_MAX_PRIORITY_FEE") {
            let max_priority_fee = max_priority_fee.parse()?;
            if priority_fee > max_priority_fee {
                tracing::info!(
                    priority_fee,
                    max_priority_fee,
                    "Estimated priority fee is very high, capping to a max",
                );
                priority_fee = max_priority_fee;
            }
        }

        // Bump the priority fee to be conservative
        let priority_fee = (priority_fee * PRIORITY_FEE_MULTIPLIER_NUMERATOR)
            / PRIORITY_FEE_MULTIPLIER_DENOMINATOR;

        Ok(SealevelTxCostEstimate {
            compute_units: simulation_compute_units,
            compute_unit_price_micro_lamports: priority_fee,
        })
    }

    /// Builds a transaction with estimated costs for a given instruction.
    pub async fn build_estimated_tx_for_instruction(
        &self,
        instruction: Instruction,
        payer: &Keypair,
        tx_submitter: &dyn TransactionSubmitter,
        priority_fee_oracle: &dyn PriorityFeeOracle,
    ) -> ChainResult<Transaction> {
        // Get the estimated costs for the instruction.
        let SealevelTxCostEstimate {
            compute_units,
            compute_unit_price_micro_lamports,
        } = self
            .get_estimated_costs_for_instruction(
                instruction.clone(),
                payer,
                tx_submitter,
                priority_fee_oracle,
            )
            .await?;

        tracing::info!(
            ?compute_units,
            ?compute_unit_price_micro_lamports,
            "Got compute units and compute unit price / priority fee for transaction"
        );

        // Build the final transaction with the correct compute unit limit and price.
        let tx = self
            .create_transaction_for_instruction(
                compute_units,
                compute_unit_price_micro_lamports,
                instruction,
                payer,
                tx_submitter,
                true,
            )
            .await?;

        Ok(tx)
    }

    /// Creates a transaction for a given instruction, compute unit limit, and compute unit price.
    /// If `sign` is true, the transaction will be signed.
    pub async fn create_transaction_for_instruction(
        &self,
        compute_unit_limit: u32,
        compute_unit_price_micro_lamports: u64,
        instruction: Instruction,
        payer: &Keypair,
        tx_submitter: &dyn TransactionSubmitter,
        sign: bool,
    ) -> ChainResult<Transaction> {
        let instructions = vec![
            // Set the compute unit limit.
            ComputeBudgetInstruction::set_compute_unit_limit(compute_unit_limit),
            // Set the priority fee / tip
            tx_submitter.get_priority_fee_instruction(
                compute_unit_price_micro_lamports,
                compute_unit_limit.into(),
                &payer.pubkey(),
            ),
            instruction,
        ];

        let tx = if sign {
            // Getting the finalized blockhash eliminates the chance the blockhash
            // gets reorged out, causing the tx to be invalid. The tradeoff is this
            // will cause the tx to expire in about 47 seconds (instead of the typical 60).
            let recent_blockhash = self
                .get_latest_blockhash_with_commitment(CommitmentConfig::finalized())
                .await
                .map_err(ChainCommunicationError::from_other)?;

            Transaction::new_signed_with_payer(
                &instructions,
                Some(&payer.pubkey()),
                &[payer],
                recent_blockhash,
            )
        } else {
            Transaction::new_unsigned(Message::new(&instructions, Some(&payer.pubkey())))
        };

        Ok(tx)
    }

    pub fn url(&self) -> String {
        self.0.url()
    }
}

impl std::fmt::Debug for SealevelRpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RpcClient { ... }")
    }
}

#[cfg(test)]
mod tests;
