use futures::{stream::FuturesUnordered, StreamExt};

use crate::ChainResult;

const MAX_CONCURRENT_READS: usize = 8;

/// Reads independent items with bounded admission and returns their input order.
/// Stops admitting on failure and drains started reads before returning the first
/// error in input order. No partially fetched range is returned to the cursor.
pub async fn read_concurrently<I, F, Fut, T>(items: I, mut fetch: F) -> ChainResult<Vec<T>>
where
    I: IntoIterator,
    F: FnMut(I::Item) -> Fut,
    Fut: std::future::Future<Output = ChainResult<T>>,
{
    let mut reads = items.into_iter().enumerate().map(|(index, item)| {
        let future = fetch(item);
        async move { (index, future.await) }
    });
    let mut pending = FuturesUnordered::new();
    for read in reads.by_ref().take(MAX_CONCURRENT_READS) {
        pending.push(read);
    }

    let mut results = Vec::new();
    let mut failed = false;
    while let Some((index, result)) = pending.next().await {
        failed |= result.is_err();
        results.push((index, result));
        if !failed {
            if let Some(read) = reads.next() {
                pending.push(read);
            }
        }
    }
    results.sort_unstable_by_key(|(index, _)| *index);
    results.into_iter().map(|(_, result)| result).collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::ChainCommunicationError;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_reads_preserve_order_and_refill_behind_a_straggler() {
        let gate = &tokio::sync::Notify::new();
        let started = &AtomicUsize::new(0);
        let active = &AtomicUsize::new(0);
        let peak = &AtomicUsize::new(0);
        let reads = read_concurrently(0..25, |index| async move {
            started.fetch_add(1, Ordering::SeqCst);
            let count = active.fetch_add(1, Ordering::SeqCst).saturating_add(1);
            peak.fetch_max(count, Ordering::SeqCst);
            if index == 0 {
                gate.notified().await;
            } else {
                tokio::task::yield_now().await;
            }
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(index)
        });
        let release = async {
            while started.load(Ordering::SeqCst) <= MAX_CONCURRENT_READS {
                tokio::task::yield_now().await;
            }
            assert!(active.load(Ordering::SeqCst) > 0);
            gate.notify_one();
        };
        let (values, ()) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(reads, release)
        })
        .await
        .expect("independent reads must refill without waiting for the first");
        assert_eq!(values.unwrap(), (0..25).collect::<Vec<_>>());
        assert_eq!(started.load(Ordering::SeqCst), 25);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(peak.load(Ordering::SeqCst), MAX_CONCURRENT_READS);
    }

    #[tokio::test]
    async fn concurrent_read_failure_stops_admission_and_drains_in_input_order() {
        let failure_gate = &tokio::sync::Notify::new();
        let drain_gate = &tokio::sync::Notify::new();
        let started = &AtomicUsize::new(0);
        let completed = &AtomicUsize::new(0);
        let reads = read_concurrently(0..25, |index| async move {
            started.fetch_add(1, Ordering::SeqCst);
            if index == 1 {
                failure_gate.notified().await;
            } else {
                drain_gate.notified().await;
            }
            completed.fetch_add(1, Ordering::SeqCst);
            if index <= 1 {
                Err(ChainCommunicationError::CustomError(format!(
                    "read-{index}"
                )))
            } else {
                Ok(index)
            }
        });
        tokio::pin!(reads);
        assert!(futures::poll!(reads.as_mut()).is_pending());
        assert_eq!(started.load(Ordering::SeqCst), MAX_CONCURRENT_READS);
        failure_gate.notify_one();
        assert!(futures::poll!(reads.as_mut()).is_pending());
        assert_eq!(completed.load(Ordering::SeqCst), 1);
        assert_eq!(started.load(Ordering::SeqCst), MAX_CONCURRENT_READS);
        drain_gate.notify_waiters();
        let error = reads.await.unwrap_err();
        assert!(error.to_string().contains("read-0"));
        assert_eq!(completed.load(Ordering::SeqCst), MAX_CONCURRENT_READS);
        assert_eq!(started.load(Ordering::SeqCst), MAX_CONCURRENT_READS);
    }

    #[tokio::test]
    async fn concurrent_reads_keep_empty_and_noncontiguous_inputs() {
        let empty = read_concurrently(std::iter::empty::<u32>(), |index| async move { Ok(index) })
            .await
            .unwrap();
        assert!(empty.is_empty());
        let values = read_concurrently([9, 2, 20], |index| async move { Ok(index) })
            .await
            .unwrap();
        assert_eq!(values, vec![9, 2, 20]);
    }
}
