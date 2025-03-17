/// Transaction Submitter config
pub mod config;

use config::TransactionSubmitterConfig;
use derive_new::new;
use hyperlane_core::ChainResult;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction, instruction::Instruction, pubkey::Pubkey,
    signature::Signature, transaction::Transaction,
};

use crate::provider::fallback::SealevelFallbackProvider;

/// The minimum tip to include in a transaction.
/// From https://docs.jito.wtf/lowlatencytxnsend/#sendtransaction
const JITO_MINIMUM_TIP_LAMPORTS: u64 = 1000;

/// Transaction Submitter
/// Configured to work with either Jito or Rpc
#[derive(Clone, Debug, new)]
pub struct TransactionSubmitter {
    /// COnfig, for jito or rpc
    pub config: TransactionSubmitterConfig,
    /// provider
    pub provider: SealevelFallbackProvider,
}

impl TransactionSubmitter {
    /// Get the RPC client
    pub fn get_provider(&self) -> &SealevelFallbackProvider {
        &self.provider
    }

    /// Get the instruction to set the compute unit price.
    pub fn get_priority_fee_instruction(
        &self,
        compute_unit_price_micro_lamports: u64,
        compute_units: u64,
        payer: &Pubkey,
    ) -> Instruction {
        match self.config {
            TransactionSubmitterConfig::Jito { .. } => Self::jito_get_priority_fee_instruction(
                compute_unit_price_micro_lamports,
                compute_units,
                payer,
            ),
            TransactionSubmitterConfig::Rpc { .. } => {
                Self::rpc_get_priority_fee_instruction(compute_unit_price_micro_lamports)
            }
        }
    }

    /// Send a transaction to the chain.
    pub async fn send_transaction(
        &self,
        transaction: &Transaction,
        skip_preflight: bool,
    ) -> ChainResult<Signature> {
        self.provider
            .call(move |provider| {
                let transaction = transaction.clone();
                let skip_preflight = skip_preflight.clone();
                let future = async move {
                    provider
                        .rpc_client()
                        .send_transaction(&transaction, skip_preflight)
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    fn rpc_get_priority_fee_instruction(compute_unit_price_micro_lamports: u64) -> Instruction {
        ComputeBudgetInstruction::set_compute_unit_price(compute_unit_price_micro_lamports)
    }

    fn jito_get_priority_fee_instruction(
        compute_unit_price_micro_lamports: u64,
        compute_units: u64,
        payer: &Pubkey,
    ) -> Instruction {
        // Divide by 1_000_000 to convert from microlamports to lamports.
        let tip_lamports = (compute_units * compute_unit_price_micro_lamports) / 1_000_000;
        let tip_lamports = tip_lamports.max(JITO_MINIMUM_TIP_LAMPORTS);

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
}
