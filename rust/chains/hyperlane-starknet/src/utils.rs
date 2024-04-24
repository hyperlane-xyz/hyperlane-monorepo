use std::future::Future;

use starknet::{
    core::types::{FieldElement, MaybePendingTransactionReceipt},
    providers::{AnyProvider, Provider, ProviderError},
};

pub async fn assert_poll<F, Fut>(f: F, polling_time_ms: u64, max_poll_count: u32)
where
    F: Fn() -> Fut,
    Fut: Future<Output = bool>,
{
    for _poll_count in 0..max_poll_count {
        if f().await {
            return; // The provided function returned true, exit safely.
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(polling_time_ms)).await;
    }

    panic!("Max poll count exceeded.");
}

type TransactionReceiptResult = Result<MaybePendingTransactionReceipt, ProviderError>;

pub async fn get_transaction_receipt(
    rpc: &AnyProvider,
    transaction_hash: FieldElement,
) -> TransactionReceiptResult {
    // there is a delay between the transaction being available at the client
    // and the sealing of the block, hence sleeping for 100ms
    assert_poll(
        || async { rpc.get_transaction_receipt(transaction_hash).await.is_ok() },
        100,
        20,
    )
    .await;

    rpc.get_transaction_receipt(transaction_hash).await
}
