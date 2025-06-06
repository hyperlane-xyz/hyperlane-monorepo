/// Transaction Submitter config
pub mod config;

use std::sync::Arc;

use async_trait::async_trait;
use derive_new::new;
use solana_sdk::{
    commitment_config::CommitmentConfig, compute_budget::ComputeBudgetInstruction,
    instruction::Instruction, pubkey::Pubkey, signature::Signature, transaction::Transaction,
};

use hyperlane_core::ChainResult;

use crate::{SealevelProvider, SealevelProviderForLander};

/// A trait for submitting transactions to the chain.
#[async_trait]
pub trait TransactionSubmitter: Send + Sync {
    /// Get the instruction to set the compute unit price.
    fn get_priority_fee_instruction(
        &self,
        compute_unit_price_micro_lamports: u64,
        compute_units: u64,
        payer: &Pubkey,
    ) -> Instruction;

    /// Send a transaction to the chain.
    async fn send_transaction(
        &self,
        transaction: &Transaction,
        skip_preflight: bool,
    ) -> ChainResult<Signature>;

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

/// A transaction submitter that uses the vanilla RPC to submit transactions.
#[derive(Debug, new)]
pub struct RpcTransactionSubmitter {
    provider: Arc<SealevelProvider>,
}

#[async_trait]
impl TransactionSubmitter for RpcTransactionSubmitter {
    fn get_priority_fee_instruction(
        &self,
        compute_unit_price_micro_lamports: u64,
        _compute_units: u64,
        _payer: &Pubkey,
    ) -> Instruction {
        ComputeBudgetInstruction::set_compute_unit_price(compute_unit_price_micro_lamports)
    }

    async fn send_transaction(
        &self,
        transaction: &Transaction,
        skip_preflight: bool,
    ) -> ChainResult<Signature> {
        self.provider
            .rpc_client()
            .send_transaction(transaction, skip_preflight)
            .await
    }

    async fn wait_for_transaction_confirmation(
        &self,
        transaction: &Transaction,
    ) -> ChainResult<()> {
        self.provider
            .wait_for_transaction_confirmation(transaction)
            .await
    }

    async fn confirm_transaction(
        &self,
        signature: Signature,
        commitment: CommitmentConfig,
    ) -> ChainResult<bool> {
        self.provider
            .confirm_transaction(signature, commitment)
            .await
    }
}

/// A transaction submitter that uses the Jito API to submit transactions.
#[derive(Debug, new)]
pub struct JitoTransactionSubmitter {
    /// Used for other operations
    default_provider: Arc<SealevelProvider>,
    /// Used to submit transactions
    submit_provider: Arc<SealevelProvider>,
}

impl JitoTransactionSubmitter {
    /// The minimum tip to include in a transaction.
    /// From https://docs.jito.wtf/lowlatencytxnsend/#sendtransaction
    const MINIMUM_TIP_LAMPORTS: u64 = 1000;
}

#[async_trait]
impl TransactionSubmitter for JitoTransactionSubmitter {
    fn get_priority_fee_instruction(
        &self,
        compute_unit_price_micro_lamports: u64,
        compute_units: u64,
        payer: &Pubkey,
    ) -> Instruction {
        // Divide by 1_000_000 to convert from microlamports to lamports.
        let tip_lamports = (compute_units * compute_unit_price_micro_lamports) / 1_000_000;
        let tip_lamports = tip_lamports.max(Self::MINIMUM_TIP_LAMPORTS);

        // The tip is a standalone transfer to a Jito fee account.
        // See https://github.com/jito-labs/mev-protos/blob/master/json_rpc/http.md#sendbundle.
        solana_sdk::system_instruction::transfer(
            payer,
            // A random Jito fee account, taken from the getFeeAccount RPC response:
            // https://github.com/jito-labs/mev-protos/blob/master/json_rpc/http.md#gettipaccounts
            &solana_sdk::pubkey!("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"),
            tip_lamports,
        )
    }

    async fn send_transaction(
        &self,
        transaction: &Transaction,
        skip_preflight: bool,
    ) -> ChainResult<Signature> {
        self.submit_provider
            .rpc_client()
            .send_transaction(transaction, skip_preflight)
            .await
    }

    async fn wait_for_transaction_confirmation(
        &self,
        transaction: &Transaction,
    ) -> ChainResult<()> {
        self.default_provider
            .wait_for_transaction_confirmation(transaction)
            .await
    }

    async fn confirm_transaction(
        &self,
        signature: Signature,
        commitment: CommitmentConfig,
    ) -> ChainResult<bool> {
        self.default_provider
            .confirm_transaction(signature, commitment)
            .await
    }
}
