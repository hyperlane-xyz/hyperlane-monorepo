use async_trait::async_trait;
use base64::Engine;
use borsh::{BorshDeserialize, BorshSerialize};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_client::rpc_client::SerializableTransaction;
use solana_client::rpc_response::Response;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;
use solana_transaction_status::{
    option_serializer::OptionSerializer, EncodedTransactionWithStatusMeta, UiTransaction,
    UiTransactionStatusMeta,
};
use solana_transaction_status::{TransactionStatus, UiReturnDataEncoding};
use tracing::warn;

use hyperlane_core::{
    utils::to_atto, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, NativeToken, TxnInfo,
    TxnReceiptInfo, H256, H512, U256,
};

use crate::error::HyperlaneSealevelError;
use crate::fallback::{SealevelFallbackRpcClient, SubmitSealevelRpc};
use crate::priority_fee::PriorityFeeOracle;
use crate::provider::recipient::RecipientProvider;
use crate::provider::transaction::{parsed_message, txn};
use crate::utils::{decode_h256, decode_h512, decode_pubkey};
use crate::{ConnectionConf, SealevelKeypair, TransactionSubmitter};

mod recipient;
mod transaction;

const COMPUTE_UNIT_MULTIPLIER_NUMERATOR: u32 = 11;
const COMPUTE_UNIT_MULTIPLIER_DENOMINATOR: u32 = 10;

const PRIORITY_FEE_MULTIPLIER_NUMERATOR: u64 = 110;
const PRIORITY_FEE_MULTIPLIER_DENOMINATOR: u64 = 100;

/// The max amount of compute units for a transaction.
const MAX_COMPUTE_UNITS: u32 = 1_400_000;

/// Transaction cost estimate
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq, Eq)]
pub struct SealevelTxCostEstimate {
    /// Compute units estimate
    pub compute_units: u32,
    /// Compute unit price estimate
    pub compute_unit_price_micro_lamports: u64,
}

impl Default for SealevelTxCostEstimate {
    fn default() -> Self {
        Self {
            compute_units: MAX_COMPUTE_UNITS,
            compute_unit_price_micro_lamports: 0,
        }
    }
}

/// Methods of provider which are used in submitter
#[async_trait]
pub trait SealevelProviderForLander: Send + Sync {
    /// Creates Sealevel transaction for instruction
    async fn create_transaction_for_instruction(
        &self,
        compute_unit_limit: u32,
        compute_unit_price_micro_lamports: u64,
        instruction: Instruction,
        payer: &SealevelKeypair,
        tx_submitter: &dyn TransactionSubmitter,
        sign: bool,
    ) -> ChainResult<Transaction>;

    /// Estimates cost for Sealevel instruction
    async fn get_estimated_costs_for_instruction(
        &self,
        instruction: Instruction,
        payer: &SealevelKeypair,
        tx_submitter: &dyn TransactionSubmitter,
        priority_fee_oracle: &dyn PriorityFeeOracle,
    ) -> ChainResult<SealevelTxCostEstimate>;

    /// Waits for Sealevel transaction confirmation with processed commitment level
    async fn wait_for_transaction_confirmation(&self, transaction: &Transaction)
        -> ChainResult<()>;

    /// Confirm transaction
    async fn confirm_transaction(
        &self,
        signature: Signature,
        commitment: CommitmentConfig,
    ) -> ChainResult<bool>;
}

/// A wrapper around a Sealevel provider to get generic blockchain information.
#[derive(Clone, Debug)]
pub struct SealevelProvider {
    rpc_client: SealevelFallbackRpcClient,
    domain: HyperlaneDomain,
    native_token: NativeToken,
    recipient_provider: RecipientProvider,
}

#[async_trait]
impl SealevelProviderForLander for SealevelProvider {
    /// Creates a transaction for a given instruction, compute unit limit, and compute unit price.
    /// If `sign` is true, the transaction will be signed.
    async fn create_transaction_for_instruction(
        &self,
        compute_unit_limit: u32,
        compute_unit_price_micro_lamports: u64,
        instruction: Instruction,
        payer: &SealevelKeypair,
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
                .rpc_client()
                .get_latest_blockhash_with_commitment(CommitmentConfig::finalized())
                .await
                .map_err(ChainCommunicationError::from_other)?;

            Transaction::new_signed_with_payer(
                &instructions,
                Some(&payer.pubkey()),
                &[payer.keypair()],
                recent_blockhash,
            )
        } else {
            Transaction::new_unsigned(Message::new(&instructions, Some(&payer.pubkey())))
        };

        Ok(tx)
    }

    /// Gets the estimated costs for a given instruction.
    /// The return value is `Some(SealevelTxCostEstimate)` if the instruction was successfully simulated,
    /// `None` if the simulation failed.
    async fn get_estimated_costs_for_instruction(
        &self,
        instruction: Instruction,
        payer: &SealevelKeypair,
        tx_submitter: &dyn TransactionSubmitter,
        priority_fee_oracle: &dyn PriorityFeeOracle,
    ) -> ChainResult<SealevelTxCostEstimate> {
        // Build a transaction that sets the max compute units and a dummy compute unit price.
        // This is used for simulation to get the actual compute unit limit. We set dummy values
        // for the compute unit limit and price because we want to include the instructions that
        // set these in the cost estimate.
        let simulation_tx = self
            .create_transaction_for_instruction(
                MAX_COMPUTE_UNITS,
                0,
                instruction,
                payer,
                tx_submitter,
                false,
            )
            .await?;

        let simulation_result = self
            .rpc_client()
            .simulate_transaction(&simulation_tx)
            .await?;

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
        let simulation_compute_units = MAX_COMPUTE_UNITS.min(
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

        let priority_fee_numerator: u64 = std::env::var("SVM_PRIORITY_FEE_NUMERATOR")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(PRIORITY_FEE_MULTIPLIER_NUMERATOR);

        // Bump the priority fee to be conservative
        let priority_fee =
            (priority_fee * priority_fee_numerator) / PRIORITY_FEE_MULTIPLIER_DENOMINATOR;

        Ok(SealevelTxCostEstimate {
            compute_units: simulation_compute_units,
            compute_unit_price_micro_lamports: priority_fee,
        })
    }

    /// Polls the RPC until the transaction is confirmed or the blockhash
    /// expires.
    /// Standalone logic stolen from Solana's non-blocking client,
    /// decoupled from the sending of a transaction.
    async fn wait_for_transaction_confirmation(
        &self,
        transaction: &Transaction,
    ) -> ChainResult<()> {
        let signature = transaction.get_signature();

        const GET_STATUS_RETRIES: usize = usize::MAX;

        let recent_blockhash = if transaction.uses_durable_nonce() {
            self.rpc_client()
                .get_latest_blockhash_with_commitment(CommitmentConfig::processed())
                .await?
        } else {
            *transaction.get_recent_blockhash()
        };

        for status_retry in 0..GET_STATUS_RETRIES {
            let signature_statuses: Response<Vec<Option<TransactionStatus>>> = self
                .rpc_client()
                .get_signature_statuses(&[*signature])
                .await?;
            let signature_status = signature_statuses.value.first().cloned().flatten();
            match signature_status {
                Some(_) => return Ok(()),
                None => {
                    if !self
                        .rpc_client()
                        .is_blockhash_valid(recent_blockhash)
                        .await?
                    {
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

    async fn confirm_transaction(
        &self,
        signature: Signature,
        commitment: CommitmentConfig,
    ) -> ChainResult<bool> {
        self.rpc_client()
            .confirm_transaction_with_commitment(signature, commitment)
            .await
    }
}

impl SealevelProvider {
    /// constructor
    pub fn new(
        rpc_client: SealevelFallbackRpcClient,
        domain: HyperlaneDomain,
        contract_addresses: &[H256],
        conf: &ConnectionConf,
    ) -> Self {
        let native_token = conf.native_token.clone();
        let recipient_provider = RecipientProvider::new(contract_addresses);
        Self {
            rpc_client,
            domain,
            native_token,
            recipient_provider,
        }
    }

    /// Get an rpc client
    pub fn rpc_client(&self) -> &SealevelFallbackRpcClient {
        &self.rpc_client
    }

    fn validate_transaction(hash: &H512, txn: &UiTransaction) -> ChainResult<()> {
        let received_signature = txn
            .signatures
            .first()
            .ok_or(HyperlaneSealevelError::UnsignedTransaction(Box::new(*hash)))?;
        let received_hash = decode_h512(received_signature)?;

        if &received_hash != hash {
            Err(Into::<ChainCommunicationError>::into(
                HyperlaneSealevelError::IncorrectTransaction(
                    Box::new(*hash),
                    Box::new(received_hash),
                ),
            ))?;
        }
        Ok(())
    }

    fn sender(hash: &H512, txn: &UiTransaction) -> ChainResult<H256> {
        let message = parsed_message(txn)?;

        let signer = message
            .account_keys
            .first()
            .ok_or(HyperlaneSealevelError::UnsignedTransaction(Box::new(*hash)))?;
        let pubkey = decode_pubkey(&signer.pubkey)?;
        let sender = H256::from_slice(&pubkey.to_bytes());
        Ok(sender)
    }

    fn gas(meta: &UiTransactionStatusMeta) -> ChainResult<U256> {
        let OptionSerializer::Some(gas) = meta.compute_units_consumed else {
            Err(HyperlaneSealevelError::EmptyComputeUnitsConsumed)?
        };

        Ok(U256::from(gas))
    }

    /// Extracts and converts fees into atto (10^-18) units.
    ///
    /// We convert fees into atto units since otherwise a compute unit price (gas price)
    /// becomes smaller than 1 lamport (or 1 unit of native token) and the price is rounded
    /// to zero. We normalise the gas price for all the chain to be expressed in atto units.
    fn fee(&self, meta: &UiTransactionStatusMeta) -> ChainResult<U256> {
        let amount_in_native_denom = U256::from(meta.fee);

        to_atto(amount_in_native_denom, self.native_token.decimals).ok_or(
            ChainCommunicationError::CustomError("Overflow in calculating fees".to_owned()),
        )
    }

    fn meta(txn: &EncodedTransactionWithStatusMeta) -> ChainResult<&UiTransactionStatusMeta> {
        let meta = txn
            .meta
            .as_ref()
            .ok_or(HyperlaneSealevelError::EmptyMetadata)?;
        Ok(meta)
    }

    /// Builds a transaction with estimated costs for a given instruction.
    pub async fn build_estimated_tx_for_instruction(
        &self,
        instruction: Instruction,
        payer: &SealevelKeypair,
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

    async fn block_info_by_height(&self, slot: u64) -> Result<BlockInfo, ChainCommunicationError> {
        let confirmed_block = self.rpc_client.get_block(slot).await?;

        let block_hash = decode_h256(&confirmed_block.blockhash)?;

        let block_time = confirmed_block
            .block_time
            .ok_or(HyperlaneProviderError::CouldNotFindBlockByHeight(slot))?;

        let block_info = BlockInfo {
            hash: block_hash,
            timestamp: block_time as u64,
            number: slot,
        };
        Ok(block_info)
    }

    /// Simulates an Instruction that will return a list of AccountMetas.
    pub async fn get_account_metas(
        &self,
        payer: &SealevelKeypair,
        instruction: Instruction,
    ) -> ChainResult<Vec<AccountMeta>> {
        // If there's no data at all, default to an empty vec.
        let account_metas = self
            .simulate_instruction::<SimulationReturnData<Vec<SerializableAccountMeta>>>(
                &payer.pubkey(),
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

    /// Simulates an instruction, and attempts to deserialize it into a T.
    /// If no return data at all was returned, returns Ok(None).
    /// If some return data was returned but deserialization was unsuccessful,
    /// an Err is returned.
    pub async fn simulate_instruction<T: BorshDeserialize + BorshSerialize>(
        &self,
        pubkey: &Pubkey,
        instruction: Instruction,
    ) -> ChainResult<Option<T>> {
        let commitment = CommitmentConfig::finalized();
        let recent_blockhash = self
            .rpc_client()
            .get_latest_blockhash_with_commitment(commitment)
            .await?;
        let transaction = Transaction::new_unsigned(Message::new_with_blockhash(
            &[instruction],
            Some(pubkey),
            &recent_blockhash,
        ));
        let simulation = self.rpc_client().simulate_transaction(&transaction).await?;

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
}

impl HyperlaneChain for SealevelProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for SealevelProvider {
    async fn get_block_by_height(&self, slot: u64) -> ChainResult<BlockInfo> {
        let block_info = self.block_info_by_height(slot).await?;
        Ok(block_info)
    }

    /// TODO This method is superfluous for Solana.
    /// Since we have to request full block to find transaction hash and transaction index
    /// for Solana, we have all the data about transaction mach earlier before this
    /// method is invoked.
    /// We can refactor abstractions so that our chain-agnostic code is more suitable
    /// for all chains, not only Ethereum-like chains.
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let signature = Signature::new(hash.as_bytes());

        let txn_confirmed = self.rpc_client.get_transaction(signature).await?;
        let txn_with_meta = &txn_confirmed.transaction;

        let txn = txn(txn_with_meta)?;

        Self::validate_transaction(hash, txn)?;
        let sender = Self::sender(hash, txn)?;
        let recipient = self.recipient_provider.recipient(hash, txn)?;
        let meta = Self::meta(txn_with_meta)?;
        let gas_used = Self::gas(meta)?;
        let fee = self.fee(meta)?;

        if fee < gas_used {
            warn!(tx_hash = ?hash, ?fee, ?gas_used, "calculated fee is less than gas used. it will result in zero gas price");
        }

        let gas_price = Some(fee / gas_used);

        let receipt = TxnReceiptInfo {
            gas_used,
            cumulative_gas_used: gas_used,
            effective_gas_price: gas_price,
        };

        Ok(TxnInfo {
            hash: *hash,
            gas_limit: gas_used,
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            gas_price,
            nonce: 0,
            sender,
            recipient: Some(recipient),
            receipt: Some(receipt),
            raw_input_data: None,
        })
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // FIXME
        Ok(true)
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let pubkey = decode_pubkey(&address)?;
        self.rpc_client.get_balance(pubkey).await
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        let slot = self.rpc_client.get_slot_raw().await?;
        let latest_block = self.block_info_by_height(slot).await?;
        let chain_info = ChainInfo {
            latest_block,
            min_gas_price: None,
        };
        Ok(Some(chain_info))
    }
}
