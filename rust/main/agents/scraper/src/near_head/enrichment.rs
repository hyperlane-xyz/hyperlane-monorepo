//! One receipt worker schedules independent pages for all indexed event types.
use std::time::Duration;

use futures::future::join_all;
use prometheus::GaugeVec;
use tokio::{
    sync::{watch, Semaphore},
    time::{sleep, timeout, Instant},
};
use tracing::warn;

use crate::{
    db::{ReceiptStream, RECEIPT_PAGE_SIZE},
    store::HyperlaneDbStore,
};

const RECEIPT_TIMEOUT: Duration = Duration::from_secs(30);
const RECEIPT_RPC_CONCURRENCY: usize = 16;
const RECEIPT_RPC_DOMAIN_CONCURRENCY: usize = 4;
const RECEIPT_DB_CONCURRENCY: usize = 5;
static RECEIPT_RPC_PERMITS: Semaphore = Semaphore::const_new(RECEIPT_RPC_CONCURRENCY);
static RECEIPT_DB_PERMITS: Semaphore = Semaphore::const_new(RECEIPT_DB_CONCURRENCY);

#[derive(Debug, PartialEq, Eq)]
enum PageOutcome {
    More,
    Idle,
    Retry,
}

impl PageOutcome {
    async fn wait(self, delay: Duration, wakeup: &mut watch::Receiver<()>) {
        match self {
            Self::More => tokio::task::yield_now().await,
            Self::Idle => tokio::select! {
                _ = sleep(delay) => {}
                changed = wakeup.changed() => { changed.expect("Receipt wake-up sender dropped"); }
            },
            // New indexed work must not bypass RPC/DB failure backoff.
            Self::Retry => sleep(delay).await,
        }
    }
}

/// Scan on startup and ingestion, with a periodic fallback and failure cooldowns.
/// Completed pages are rescheduled independently, so one slow receipt cannot block other types.
pub(super) async fn run(
    store: &HyperlaneDbStore,
    poll_interval: Duration,
    oldest_pending_seconds: &GaugeVec,
    wakeup: watch::Receiver<()>,
) {
    let domain_rpc_permits = Semaphore::new(RECEIPT_RPC_DOMAIN_CONCURRENCY);
    join_all(ReceiptStream::ALL.into_iter().map(|stream| {
        run_stream(
            store,
            stream,
            poll_interval,
            wakeup.clone(),
            &domain_rpc_permits,
            oldest_pending_seconds,
        )
    }))
    .await;
}

async fn run_stream(
    store: &HyperlaneDbStore,
    stream: ReceiptStream,
    poll_interval: Duration,
    mut wakeup: watch::Receiver<()>,
    domain_rpc_permits: &Semaphore,
    oldest_pending_seconds: &GaugeVec,
) {
    let period_ms = u64::try_from(poll_interval.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    let salt = match stream {
        ReceiptStream::Dispatch => 0,
        ReceiptStream::Delivery => 1,
        ReceiptStream::GasPayment => 2,
    };
    let stagger = u64::from(store.domain.id())
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_mul(3)
        .wrapping_add(salt)
        .checked_rem(period_ms)
        .expect("Positive poll interval");
    PageOutcome::Idle
        .wait(
            Duration::from_millis(if cfg!(test) { 0 } else { stagger }),
            &mut wakeup,
        )
        .await;
    let mut last_age_sample: Option<Instant> = None;
    let mut after = 0;
    let mut outcome = PageOutcome::More;
    loop {
        outcome.wait(poll_interval, &mut wakeup).await;
        // Remember hints arriving during a read/fetch, so the next idle page runs immediately.
        wakeup.borrow_and_update();
        outcome = enrich_page(
            store,
            stream,
            &mut after,
            RECEIPT_TIMEOUT,
            domain_rpc_permits,
        )
        .await;
        if !matches!(stream, ReceiptStream::Dispatch)
            && last_age_sample.is_none_or(|last| last.elapsed() >= poll_interval)
        {
            last_age_sample = Some(Instant::now());
            if let result @ (Err(_) | Ok(Err(_))) = timeout(
                RECEIPT_TIMEOUT,
                update_pending_age(store, stream, oldest_pending_seconds),
            )
            .await
            {
                warn!(
                    domain = store.domain.id(),
                    ?result,
                    "Receipt backlog measurement failed"
                );
            }
        }
    }
}

/// Sample backlog only while processing a stream, never on an idle timer.
async fn update_pending_age(
    store: &HyperlaneDbStore,
    stream: ReceiptStream,
    oldest_pending_seconds: &GaugeVec,
) -> eyre::Result<()> {
    let _db_permit = RECEIPT_DB_PERMITS.acquire().await?;
    let age = store
        .db
        .pending_receipt_age(store.domain.id(), stream)
        .await?;
    oldest_pending_seconds
        .with_label_values(&[store.domain.name(), stream.metric_label()])
        .set(age);
    Ok(())
}

/// Drain healthy full pages; distinguish idle waits from failure cooldowns.
async fn enrich_page(
    store: &HyperlaneDbStore,
    stream: ReceiptStream,
    after: &mut i64,
    deadline: Duration,
    domain_rpc_permits: &Semaphore,
) -> PageOutcome {
    let start = *after;
    let mut ids = Vec::new();
    let result = timeout(deadline, async {
        let db_permit = RECEIPT_DB_PERMITS.acquire().await?;
        let rows = store
            .db
            .pending_receipts(store.domain.id(), stream, start)
            .await?;
        drop(db_permit);
        *after = rows.last().map(|(id, _)| *id).unwrap_or(0);
        ids = rows.iter().map(|(id, _)| *id).collect();
        let complete = store
            .ensure_transactions_for_known_blocks(
                rows.iter().map(|(_, meta)| meta),
                &RECEIPT_RPC_PERMITS,
                domain_rpc_permits,
                &RECEIPT_DB_PERMITS,
            )
            .await?;
        Ok::<_, eyre::Report>((complete, rows.len() == RECEIPT_PAGE_SIZE))
    })
    .await;

    // Persisted successes are linked even when another receipt timed out. Keep
    // this separate from fetch cancellation, but bound its own database wait.
    let linked = if !ids.is_empty() {
        let result = timeout(deadline, async {
            let _db_permit = RECEIPT_DB_PERMITS.acquire().await?;
            store
                .db
                .link_receipts(store.domain.id(), stream, &ids)
                .await
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            warn!(
                domain = store.domain.id(),
                table = stream.table(),
                ?result,
                "Receipt linking failed; retrying"
            );
        }
        matches!(result, Ok(Ok(())))
    } else {
        true
    };
    match result {
        Ok(Ok((true, more))) if linked => {
            if more {
                PageOutcome::More
            } else {
                // A completed sweep restarts before wake-ups can keep appending newer rows.
                *after = 0;
                PageOutcome::Idle
            }
        }
        Ok(Ok(_)) => PageOutcome::Retry,
        result => {
            warn!(
                domain = store.domain.id(),
                table = stream.table(),
                ?result,
                "Event transaction enrichment failed; retrying"
            );
            PageOutcome::Retry
        }
    }
}

#[cfg(test)]
pub(super) async fn enrich_with_timeout(
    store: &HyperlaneDbStore,
    cursors: &mut [i64; 3],
    deadline: Duration,
) {
    let domain_rpc_permits = Semaphore::new(RECEIPT_RPC_DOMAIN_CONCURRENCY);
    for (stream, after) in ReceiptStream::ALL.into_iter().zip(cursors) {
        enrich_page(store, stream, after, deadline, &domain_rpc_permits).await;
    }
}

#[cfg(test)]
mod tests;
