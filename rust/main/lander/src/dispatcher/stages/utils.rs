use std::borrow::Cow;
use std::{future::Future, time::Duration};

use futures_util::{stream, Stream, StreamExt};
use tokio::time::sleep;
use tracing::{error, info, instrument};

use crate::{
    dispatcher::metrics::DispatcherMetrics,
    error::{IsRetryable, LanderError},
    transaction::{Transaction, TransactionStatus},
};

use super::DispatcherState;

/// Polls futures concurrently while yielding completed prefixes in input order.
pub(super) fn buffer_ordered_bounded<Fut, T>(
    futures: impl IntoIterator<Item = Fut>,
    max_concurrency: usize,
) -> impl Stream<Item = T>
where
    Fut: Future<Output = T>,
{
    assert!(max_concurrency > 0, "concurrency must be non-zero");

    stream::iter(futures).buffered(max_concurrency)
}

pub(super) fn sort_transactions_for_mutation(transactions: &mut [Transaction]) {
    transactions.sort_unstable_by(|left, right| {
        left.creation_timestamp
            .cmp(&right.creation_timestamp)
            .then_with(|| left.uuid.as_bytes().cmp(right.uuid.as_bytes()))
    });
}

#[derive(Clone, Copy)]
pub(super) enum FinalizedStatusRead {
    Query,
    TrustPersisted,
}

pub(super) async fn read_transaction_status_batch(
    state: &DispatcherState,
    snapshot_txs: Vec<Transaction>,
    finalized_status_read: FinalizedStatusRead,
) -> Vec<(
    Transaction,
    Transaction,
    Result<TransactionStatus, LanderError>,
)> {
    let mut checked_txs = snapshot_txs.clone();
    let checked_at = chrono::Utc::now();
    for tx in &mut checked_txs {
        tx.last_status_check = Some(checked_at);
    }
    let status_slots = checked_txs
        .iter()
        .map(|tx| {
            if tx.status == TransactionStatus::Finalized
                && matches!(finalized_status_read, FinalizedStatusRead::TrustPersisted)
            {
                Some(Ok(TransactionStatus::Finalized))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    // Most batches query every transaction. Borrow their checked copies; only
    // mixed/finalized batches need a separate filtered, owned query buffer.
    let query_txs: Cow<'_, [Transaction]> = if status_slots.iter().any(Option::is_some) {
        Cow::Owned(
            checked_txs
                .iter()
                .zip(&status_slots)
                .filter(|(_, status)| status.is_none())
                .map(|(tx, _)| tx.clone())
                .collect(),
        )
    } else {
        Cow::Borrowed(&checked_txs)
    };
    let queried_statuses = state.adapter.tx_statuses(&query_txs).await;
    assert_eq!(
        queried_statuses.len(),
        query_txs.len(),
        "adapter returned a mismatched transaction status count"
    );
    let mut queried_statuses = queried_statuses.into_iter();
    let statuses = status_slots
        .into_iter()
        .map(|status| {
            status.unwrap_or_else(|| {
                queried_statuses
                    .next()
                    .expect("queried transaction status count was checked")
            })
        })
        .collect::<Vec<_>>();
    snapshot_txs
        .into_iter()
        .zip(checked_txs)
        .zip(statuses)
        .map(|((snapshot_tx, checked_tx), status)| (snapshot_tx, checked_tx, status))
        .collect()
}

pub async fn call_until_success_or_nonretryable_error<F, T, Fut>(
    f: F,
    action: &str,
    state: &DispatcherState,
) -> Result<T, LanderError>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, LanderError>>,
{
    loop {
        match f().await {
            Ok(result) => return Ok(result),
            Err(err) => {
                if err.is_retryable() {
                    error!(?err, ?action, "Error making call. Retrying...");
                    sleep(Duration::from_secs(1)).await;
                } else {
                    return Err(LanderError::NonRetryableError(err.to_string()));
                }
                state.metrics.update_call_retries_metric(
                    &err.to_metrics_label(),
                    action,
                    state.domain.as_str(),
                );
            }
        }
    }
}

#[instrument(
    skip_all,
    name = "UpdateTxStatus::update_tx_status",
    fields(tx_uuid = ?tx.uuid, previous_tx_status = ?tx.status, next_tx_status = ?new_status, payloads = ?tx.payload_details)
)]
pub async fn update_tx_status(
    state: &DispatcherState,
    tx: &mut Transaction,
    new_status: TransactionStatus,
) -> Result<(), LanderError> {
    info!(?tx, ?new_status, "Updating tx status");
    let old_tx_status = tx.status.clone();
    tx.status = new_status.clone();
    state.store_tx(tx).await;

    // return early to avoid double counting metrics
    if new_status == old_tx_status {
        return Ok(());
    }
    // these metric updates assume a transaction can only be finalized once and dropped once.
    // note that a transaction may be counted as `finalized` initially, and then later
    // also counted as `dropped` if it was reorged out.
    match tx.status {
        TransactionStatus::Finalized => {
            state
                .metrics
                .update_finalized_transactions_metric(&state.domain);
        }
        TransactionStatus::Dropped(ref reason) => {
            state
                .metrics
                .update_dropped_transactions_metric(&format!("{reason:?}"), &state.domain);
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    use tokio::sync::Semaphore;

    use hyperlane_core::identifiers::UniqueIdentifier;
    use uuid::Uuid;

    use crate::{tests::test_utils::dummy_tx, transaction::TransactionStatus};

    use futures_util::StreamExt;

    use super::{buffer_ordered_bounded, sort_transactions_for_mutation};

    #[test]
    fn transactions_are_sorted_by_creation_then_uuid() {
        let timestamp = chrono::Utc::now();
        let mut same_time_later_uuid = dummy_tx(vec![], TransactionStatus::Included);
        same_time_later_uuid.creation_timestamp = timestamp;
        same_time_later_uuid.uuid = UniqueIdentifier::new(Uuid::from_u128(2));
        let mut same_time_earlier_uuid = same_time_later_uuid.clone();
        same_time_earlier_uuid.uuid = UniqueIdentifier::new(Uuid::from_u128(1));
        let mut later_creation = same_time_later_uuid.clone();
        later_creation.creation_timestamp = timestamp + chrono::Duration::seconds(1);
        later_creation.uuid = UniqueIdentifier::new(Uuid::from_u128(0));
        let mut transactions = vec![later_creation, same_time_later_uuid, same_time_earlier_uuid];

        sort_transactions_for_mutation(&mut transactions);

        assert_eq!(transactions[0].uuid.as_u128(), 1);
        assert_eq!(transactions[1].uuid.as_u128(), 2);
        assert_eq!(transactions[2].uuid.as_u128(), 0);
    }

    #[tokio::test]
    async fn ordered_bounded_stream_yields_completed_prefix_before_later_read() {
        const CONCURRENCY: usize = 4;
        const ITEM_COUNT: usize = 8;

        let second_read_gate = Arc::new(Semaphore::new(0));

        let futures = (0..ITEM_COUNT).map(|index| {
            let second_read_gate = second_read_gate.clone();
            async move {
                if index == 1 {
                    second_read_gate
                        .acquire()
                        .await
                        .expect("test semaphore is not closed")
                        .forget();
                }

                index
            }
        });

        let mut stream = Box::pin(buffer_ordered_bounded(futures, CONCURRENCY));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), stream.next())
                .await
                .expect("the completed prefix should be yielded")
                .expect("the stream should contain the first result"),
            0
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(10), stream.next())
                .await
                .is_err(),
            "input order should still wait for the gated second result"
        );
        second_read_gate.add_permits(1);
        assert_eq!(
            stream.collect::<Vec<_>>().await,
            (1..ITEM_COUNT).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn ordered_bounded_collection_enforces_concurrency_cap() {
        const CONCURRENCY: usize = 4;
        const ITEM_COUNT: usize = 8;

        let started = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Semaphore::new(0));
        let started_for_futures = started.clone();
        let gate_for_futures = gate.clone();
        let futures = (0..ITEM_COUNT).map(move |index| {
            let started = started_for_futures.clone();
            let gate = gate_for_futures.clone();
            async move {
                started.fetch_add(1, Ordering::SeqCst);
                gate.acquire()
                    .await
                    .expect("test semaphore is not closed")
                    .forget();
                index
            }
        });

        let collection = tokio::spawn(async move {
            buffer_ordered_bounded(futures, CONCURRENCY)
                .collect::<Vec<_>>()
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while started.load(Ordering::SeqCst) < CONCURRENCY {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the configured number of reads should start");
        tokio::task::yield_now().await;
        assert_eq!(started.load(Ordering::SeqCst), CONCURRENCY);

        gate.add_permits(ITEM_COUNT);
        assert_eq!(
            collection.await.unwrap(),
            (0..ITEM_COUNT).collect::<Vec<_>>()
        );
    }
}

#[cfg(test)]
mod status_batch_tests;
