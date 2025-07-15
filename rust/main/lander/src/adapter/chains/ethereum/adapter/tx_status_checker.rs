use std::sync::Arc;

use ethers::types::U64;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander};
use tracing::warn;

use crate::{LanderError, TransactionStatus};

async fn block_number_result_to_tx_status(
    provider: &Arc<dyn EvmProviderForLander>,
    block_number: Option<U64>,
    reorg_period: &EthereumReorgPeriod,
) -> TransactionStatus {
    let Some(block_number) = block_number else {
        return TransactionStatus::PendingInclusion;
    };
    let block_number = block_number.as_u64();
    match provider.get_finalized_block_number(reorg_period).await {
        Ok(finalized_block) => {
            if finalized_block as u64 >= block_number {
                TransactionStatus::Finalized
            } else {
                TransactionStatus::Included
            }
        }
        Err(err) => {
            warn!(
                ?err,
                "Error checking block finality. Assuming tx is pending inclusion"
            );
            TransactionStatus::PendingInclusion
        }
    }
}

pub async fn get_tx_hash_status(
    provider: &Arc<dyn EvmProviderForLander>,
    hash: hyperlane_core::H512,
    reorg_period: &EthereumReorgPeriod,
) -> Result<TransactionStatus, LanderError> {
    match provider.get_transaction_receipt(hash.into()).await {
        Ok(None) => Err(LanderError::TxHashNotFound(
            "Transaction not found".to_string(),
        )),
        Ok(Some(receipt)) => {
            Ok(
                block_number_result_to_tx_status(provider, receipt.block_number, reorg_period)
                    .await,
            )
        }
        Err(err) => Err(LanderError::TxHashNotFound(err.to_string())),
    }
}
