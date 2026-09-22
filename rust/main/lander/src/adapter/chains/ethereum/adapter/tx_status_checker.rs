use std::sync::Arc;

use ethers::types::U64;
use futures_util::{stream, StreamExt};
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander};
use tracing::warn;

use crate::{transaction::Transaction, LanderError, TransactionDropReason, TransactionStatus};

pub(super) const STATUS_READ_BATCH_SIZE: usize = 16;

fn block_number_to_tx_status(
    block_number: Option<U64>,
    finalized_block: Option<u32>,
) -> TransactionStatus {
    match (block_number, finalized_block) {
        (Some(block), Some(finalized)) if finalized as u64 >= block.as_u64() => {
            TransactionStatus::Finalized
        }
        (Some(_), Some(_)) => TransactionStatus::Included,
        _ => TransactionStatus::Mempool,
    }
}

async fn read_finalized_block(
    provider: &Arc<dyn EvmProviderForLander>,
    reorg_period: &EthereumReorgPeriod,
) -> Option<u32> {
    match provider.get_finalized_block_number(reorg_period).await {
        Ok(block) => Some(block),
        Err(err) => {
            warn!(
                ?err,
                "Error checking block finality. Assuming tx is in mempool since we got tx receipt"
            );
            None
        }
    }
}

async fn read_tx_hash_block(
    provider: &Arc<dyn EvmProviderForLander>,
    hash: hyperlane_core::H512,
) -> Result<Option<U64>, LanderError> {
    match provider.get_transaction_receipt(hash.into()).await {
        Ok(None) => Err(LanderError::TxHashNotFound(
            "Transaction not found".to_string(),
        )),
        Ok(Some(receipt)) => {
            tracing::debug!(?receipt, "tx receipt");
            Ok(receipt.block_number)
        }
        Err(err) => Err(LanderError::TxHashNotFound(err.to_string())),
    }
}

pub async fn get_tx_hash_status(
    provider: &Arc<dyn EvmProviderForLander>,
    hash: hyperlane_core::H512,
    reorg_period: &EthereumReorgPeriod,
) -> Result<TransactionStatus, LanderError> {
    let block_number = read_tx_hash_block(provider, hash).await?;
    let finalized = if block_number.is_some() {
        read_finalized_block(provider, reorg_period).await
    } else {
        None
    };
    Ok(block_number_to_tx_status(block_number, finalized))
}

/// Bound receipt reads across replacement histories and share one finality read per scan batch.
pub(super) async fn get_tx_statuses(
    provider: &Arc<dyn EvmProviderForLander>,
    txs: &[Transaction],
    reorg_period: &EthereumReorgPeriod,
) -> Vec<Result<TransactionStatus, LanderError>> {
    let hashes = txs
        .iter()
        .enumerate()
        .flat_map(|(index, tx)| tx.tx_hashes.iter().map(move |hash| (index, *hash)))
        .collect::<Vec<_>>();
    let reads = stream::iter(hashes)
        .map(|(index, hash)| async move { (index, read_tx_hash_block(provider, hash).await) })
        .buffer_unordered(STATUS_READ_BATCH_SIZE);
    futures_util::pin_mut!(reads);
    let mut blocks: Vec<Vec<_>> = (0..txs.len()).map(|_| Vec::new()).collect();
    let mut has_included_receipt = false;
    while let Some((index, block)) = reads.next().await {
        has_included_receipt |= matches!(block, Ok(Some(_)));
        blocks[index].push(block);
    }
    // Use one finality height observed after every receipt read in this batch.
    let finalized = if has_included_receipt {
        read_finalized_block(provider, reorg_period).await
    } else {
        None
    };
    blocks
        .into_iter()
        .map(|blocks| {
            let statuses = blocks
                .into_iter()
                .map(|block| block.map(|block| block_number_to_tx_status(block, finalized)))
                .collect();
            Ok(TransactionStatus::classify_tx_status_from_hash_statuses(
                statuses,
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fmt::Debug;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use ethers::{
        providers::{HttpClientError, JsonRpcClient, Middleware, MockProvider, Provider},
        types::{Address, Bloom, TransactionReceipt, H256, U256},
    };
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, H512};
    use hyperlane_ethereum::EthereumProvider;
    use serde::{de::DeserializeOwned, Serialize};

    use crate::{adapter::chains::ethereum::tests::MockEvmProvider, tests::test_utils::dummy_tx};

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

    fn transactions(count: usize, hashes_per_transaction: usize) -> Vec<Transaction> {
        (0..count)
            .map(|index| {
                let mut tx = dummy_tx(vec![], TransactionStatus::Mempool);
                tx.tx_hashes = (0..hashes_per_transaction)
                    .map(|offset| {
                        H256::from_low_u64_be((index * hashes_per_transaction + offset + 1) as u64)
                            .into()
                    })
                    .collect();
                tx
            })
            .collect()
    }

    #[derive(Debug, Default)]
    struct ReceiptCounters {
        active: AtomicUsize,
        peak: AtomicUsize,
        total: AtomicUsize,
    }

    #[derive(Debug, Clone, Default)]
    struct PendingReceiptClient(Arc<ReceiptCounters>);

    #[async_trait]
    impl JsonRpcClient for PendingReceiptClient {
        type Error = HttpClientError;

        async fn request<T, R>(&self, method: &str, _params: T) -> Result<R, Self::Error>
        where
            T: Debug + Serialize + Send + Sync,
            R: DeserializeOwned,
        {
            assert_eq!(method, "eth_getTransactionReceipt");
            self.0.total.fetch_add(1, Ordering::Relaxed);
            let active = self.0.active.fetch_add(1, Ordering::Relaxed) + 1;
            self.0.peak.fetch_max(active, Ordering::Relaxed);
            tokio::task::yield_now().await;
            self.0.active.fetch_sub(1, Ordering::Relaxed);
            serde_json::from_value(serde_json::Value::Null).map_err(|err| {
                HttpClientError::SerdeJson {
                    err,
                    text: "null".to_owned(),
                }
            })
        }
    }

    #[tokio::test]
    async fn batch_bounds_receipt_reads_across_replacement_histories() {
        let client = PendingReceiptClient::default();
        let provider: Arc<dyn EvmProviderForLander> = Arc::new(EthereumProvider::new(
            Arc::new(Provider::new(client.clone())),
            KnownHyperlaneDomain::Ethereum.into(),
        ));
        let txs = transactions(16, 32);
        let reorg_period = EthereumReorgPeriod::Blocks(15);

        // The previous adapter path joins every replacement hash for each eligible transaction.
        let legacy = txs
            .iter()
            .flat_map(|tx| tx.tx_hashes.iter())
            .map(|hash| get_tx_hash_status(&provider, *hash, &reorg_period));
        futures_util::future::join_all(legacy).await;
        assert_eq!(client.0.total.swap(0, Ordering::Relaxed), 512);
        assert_eq!(client.0.peak.swap(0, Ordering::Relaxed), 512);

        let statuses = get_tx_statuses(&provider, &txs, &reorg_period).await;
        assert!(statuses
            .into_iter()
            .all(|status| status.unwrap() == TransactionStatus::PendingInclusion));
        assert_eq!(client.0.total.load(Ordering::Relaxed), 512);
        assert_eq!(
            client.0.peak.load(Ordering::Relaxed),
            STATUS_READ_BATCH_SIZE
        );
        assert_eq!(client.0.active.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn batch_shares_one_finalized_height_read() {
        let receipt_reads = Arc::new(AtomicUsize::new(0));
        let receipt_reads_for_receipts = receipt_reads.clone();
        let mut mock = MockEvmProvider::new();
        mock.expect_get_transaction_receipt()
            .times(16)
            .returning(move |hash| {
                receipt_reads_for_receipts.fetch_add(1, Ordering::Relaxed);
                Ok(Some(test_tx_receipt(hash.into(), Some(1.into()))))
            });
        mock.expect_get_finalized_block_number()
            .times(1)
            .returning(move |_| {
                assert_eq!(receipt_reads.load(Ordering::Relaxed), 16);
                Ok(23_328_000)
            });
        let provider: Arc<dyn EvmProviderForLander> = Arc::new(mock);
        let statuses = get_tx_statuses(
            &provider,
            &transactions(16, 1),
            &EthereumReorgPeriod::Blocks(15),
        )
        .await;
        assert_eq!(statuses.len(), 16);
        assert!(statuses
            .into_iter()
            .all(|status| status.unwrap() == TransactionStatus::Finalized));
    }

    #[tokio::test]
    async fn batch_keeps_older_winning_hashes_and_input_order() {
        let mut mock = MockEvmProvider::new();
        mock.expect_get_transaction_receipt()
            .times(6)
            .returning(|hash| {
                if hash == hyperlane_core::H256::from_low_u64_be(1) {
                    Ok(Some(test_tx_receipt(hash.into(), Some(0.into()))))
                } else if hash == hyperlane_core::H256::from_low_u64_be(3) {
                    let mut receipt = test_tx_receipt(hash.into(), Some(1.into()));
                    receipt.block_number = None;
                    Ok(Some(receipt))
                } else if hash == hyperlane_core::H256::from_low_u64_be(5) {
                    Err(hyperlane_core::ChainCommunicationError::CustomError(
                        "receipt unavailable".into(),
                    ))
                } else {
                    Ok(None)
                }
            });
        mock.expect_get_finalized_block_number()
            .times(1)
            .returning(|_| Ok(23_328_000));
        let provider: Arc<dyn EvmProviderForLander> = Arc::new(mock);
        let mut txs = transactions(3, 2);
        txs.push(dummy_tx(vec![], TransactionStatus::PendingInclusion));
        let statuses = get_tx_statuses(&provider, &txs, &EthereumReorgPeriod::Blocks(15)).await;
        assert_eq!(
            statuses.into_iter().map(Result::unwrap).collect::<Vec<_>>(),
            [
                TransactionStatus::Finalized,
                TransactionStatus::Mempool,
                TransactionStatus::PendingInclusion,
                TransactionStatus::PendingInclusion
            ],
        );
    }

    #[tokio::test]
    async fn batch_retries_failed_finality_on_next_scan() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut mock = MockEvmProvider::new();
        mock.expect_get_transaction_receipt()
            .times(32)
            .returning(|hash| Ok(Some(test_tx_receipt(hash.into(), Some(1.into())))));
        let finality_calls = calls.clone();
        mock.expect_get_finalized_block_number()
            .times(2)
            .returning(move |_| {
                if finality_calls.fetch_add(1, Ordering::Relaxed) == 0 {
                    Err(hyperlane_core::ChainCommunicationError::CustomError(
                        "finality unavailable".into(),
                    ))
                } else {
                    Ok(23_328_000)
                }
            });
        let provider: Arc<dyn EvmProviderForLander> = Arc::new(mock);
        let txs = transactions(16, 1);
        for expected in [TransactionStatus::Mempool, TransactionStatus::Finalized] {
            let statuses = get_tx_statuses(&provider, &txs, &EthereumReorgPeriod::Blocks(15)).await;
            assert!(statuses
                .into_iter()
                .all(|status| status.unwrap() == expected));
        }
        assert_eq!(calls.load(Ordering::Relaxed), 2);
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
