use async_trait::async_trait;
use hyperlane_core::ChainResult;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction, instruction::Instruction, pubkey::Pubkey,
    signature::Signature, transaction::Transaction,
};

use crate::SealevelRpcClient;

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

    fn rpc_client(&self) -> Option<&SealevelRpcClient> {
        None
    }
}

/// A transaction submitter that uses the vanilla RPC to submit transactions.
#[derive(Debug)]
pub struct RpcTransactionSubmitter {
    rpc_client: SealevelRpcClient,
}

impl RpcTransactionSubmitter {
    pub fn new(url: String) -> Self {
        Self {
            rpc_client: SealevelRpcClient::new(url),
        }
    }
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
        self.rpc_client
            .send_transaction(transaction, skip_preflight)
            .await
    }

    fn rpc_client(&self) -> Option<&SealevelRpcClient> {
        Some(&self.rpc_client)
    }
}

/// A transaction submitter that uses the Jito API to submit transactions.
#[derive(Debug)]
pub struct JitoTransactionSubmitter {
    rpc_client: SealevelRpcClient,
}

impl JitoTransactionSubmitter {
    /// The minimum tip to include in a transaction.
    /// From https://docs.jito.wtf/lowlatencytxnsend/#sendtransaction
    const MINIMUM_TIP_LAMPORTS: u64 = 1000;

    pub fn new(url: String) -> Self {
        Self {
            rpc_client: SealevelRpcClient::new(url),
        }
    }
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
        self.rpc_client
            .send_transaction(transaction, skip_preflight)
            .await
    }
}
