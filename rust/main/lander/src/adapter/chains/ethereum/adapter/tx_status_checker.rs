use std::sync::Arc;

use ethers::types::U64;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander};
use tracing::warn;

use crate::{LanderError, TransactionDropReason, TransactionStatus};

async fn block_number_result_to_tx_status(
    provider: &Arc<dyn EvmProviderForLander>,
    block_number: Option<U64>,
    reorg_period: &EthereumReorgPeriod,
) -> TransactionStatus {
    let Some(block_number) = block_number else {
        return TransactionStatus::Mempool;
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
                "Error checking block finality. Assuming tx is in mempool since we got tx receipt"
            );
            TransactionStatus::Mempool
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
            tracing::debug!(?receipt, "tx receipt");
            Ok(
                block_number_result_to_tx_status(provider, receipt.block_number, reorg_period)
                    .await,
            )
        }
        Err(err) => Err(LanderError::TxHashNotFound(err.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use ethers::{
        providers::{Middleware, MockProvider, Provider},
        types::{Address, Bloom, TransactionReceipt, H256, U256},
    };
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, H512};
    use hyperlane_ethereum::EthereumProvider;

    use super::*;

    fn test_tx_receipt(transaction_hash: H256, status: Option<U64>) -> TransactionReceipt {
        TransactionReceipt {
            transaction_hash,
            transaction_index: U64::from(206),
            block_hash: Some(
                H256::from_str("bd36ff1aeafac61b89642ac30e682234b4dfa87c9ff6987b66f709c09f60d1d0")
                    .unwrap(),
            ),
            block_number: Some(U64::from(23327789)),
            from: Address::from_str("74cae0ecc47b02ed9b9d32e000fd70b9417970c5").unwrap(),
            to: Some(Address::from_str("c005dc82818d67af737725bd4bf75435d065d239").unwrap()),
            contract_address: None,
            cumulative_gas_used: U256::from(17343049),
            effective_gas_price: Some(U256::from(291228702)),
            gas_used: Some(U256::from(39040)),
            logs: Vec::new(),
            status,
            root: None,
            logs_bloom: Bloom::default(),
            transaction_type: Some(U64::from(206)),
        }
    }

    /// When the transaction was sent to network, but failed
    /// during execution.
    #[tokio::test]
    async fn test_get_tx_hash_status_failed_tx() {
        let transaction_hash =
            H256::from_str("575841942e0de82d3129cccf53e4e9c75b6d8a163f8a83d330a2e8d574820a4d")
                .unwrap();

        let mock_provider = MockProvider::new();
        let _ = mock_provider.push(U64::from(23328000u64));

        let tx_receipt = test_tx_receipt(transaction_hash, Some(U64::from(0)));
        let _ = mock_provider.push(tx_receipt);

        let ethers_provider = Provider::new(mock_provider);
        let evm_provider: Arc<dyn EvmProviderForLander> = Arc::new(EthereumProvider::new(
            Arc::new(ethers_provider),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        ));
        let reorg_period = EthereumReorgPeriod::Blocks(15);

        let tx_status = get_tx_hash_status(&evm_provider, transaction_hash.into(), &reorg_period)
            .await
            .unwrap();
        assert_eq!(tx_status, TransactionStatus::Finalized);
    }

    #[tokio::test]
    async fn test_get_tx_hash_status_success() {
        let transaction_hash =
            H256::from_str("575841942e0de82d3129cccf53e4e9c75b6d8a163f8a83d330a2e8d574820a4d")
                .unwrap();

        let mock_provider = MockProvider::new();

        let _ = mock_provider.push(U64::from(23327790u64));
        let tx_receipt = test_tx_receipt(transaction_hash, Some(U64::from(1)));
        let _ = mock_provider.push(tx_receipt);

        let ethers_provider = Provider::new(mock_provider);
        let evm_provider: Arc<dyn EvmProviderForLander> = Arc::new(EthereumProvider::new(
            Arc::new(ethers_provider),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        ));
        let reorg_period = EthereumReorgPeriod::Blocks(15);

        let tx_status = get_tx_hash_status(&evm_provider, transaction_hash.into(), &reorg_period)
            .await
            .unwrap();
        assert_eq!(tx_status, TransactionStatus::Included);
    }

    #[tokio::test]
    async fn test_get_tx_hash_status_success_finalized() {
        let transaction_hash =
            H256::from_str("575841942e0de82d3129cccf53e4e9c75b6d8a163f8a83d330a2e8d574820a4d")
                .unwrap();

        let mock_provider = MockProvider::new();

        let _ = mock_provider.push(U64::from(23328000u64));
        let tx_receipt = test_tx_receipt(transaction_hash, Some(U64::from(1)));
        let _ = mock_provider.push(tx_receipt);

        let ethers_provider = Provider::new(mock_provider);
        let evm_provider: Arc<dyn EvmProviderForLander> = Arc::new(EthereumProvider::new(
            Arc::new(ethers_provider),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        ));
        let reorg_period = EthereumReorgPeriod::Blocks(15);

        let tx_status = get_tx_hash_status(&evm_provider, transaction_hash.into(), &reorg_period)
            .await
            .unwrap();
        assert_eq!(tx_status, TransactionStatus::Finalized);
    }
}
