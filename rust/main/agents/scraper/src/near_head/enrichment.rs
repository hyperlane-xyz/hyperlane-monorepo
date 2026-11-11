//! One receipt worker schedules independent pages for all indexed event types.
use std::time::Duration;

use futures::{stream::FuturesUnordered, StreamExt};
use prometheus::GaugeVec;
use tokio::{
    sync::{watch, Semaphore},
    time::{sleep, timeout},
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

/// Drain healthy full pages immediately; back off on failures and between sweeps.
/// Completed pages are rescheduled independently, so one slow receipt cannot block other types.
pub(super) async fn run(
    store: &HyperlaneDbStore,
    poll_interval: Duration,
    oldest_pending_seconds: &GaugeVec,
    wakeup: watch::Receiver<()>,
) {
    let domain_rpc_permits = Semaphore::new(RECEIPT_RPC_DOMAIN_CONCURRENCY);
    tokio::join!(
        run_pages(store, poll_interval, wakeup, &domain_rpc_permits),
        monitor_backlog(store, poll_interval, oldest_pending_seconds),
    );
}

struct ReceiptScan {
    stream: ReceiptStream,
    after: i64,
    outcome: PageOutcome,
    wakeup: watch::Receiver<()>,
}

async fn run_pages(
    store: &HyperlaneDbStore,
    poll_interval: Duration,
    wakeup: watch::Receiver<()>,
    domain_rpc_permits: &Semaphore,
) {
    let mut pages = FuturesUnordered::new();
    for stream in ReceiptStream::ALL {
        pages.push(next_page(
            store,
            ReceiptScan {
                stream,
                after: 0,
                outcome: PageOutcome::More,
                wakeup: wakeup.clone(),
            },
            poll_interval,
            domain_rpc_permits,
        ));
    }
    while let Some(scan) = pages.next().await {
        pages.push(next_page(store, scan, poll_interval, domain_rpc_permits));
    }
}

async fn next_page(
    store: &HyperlaneDbStore,
    mut scan: ReceiptScan,
    poll_interval: Duration,
    domain_rpc_permits: &Semaphore,
) -> ReceiptScan {
    scan.outcome.wait(poll_interval, &mut scan.wakeup).await;
    // Remember hints arriving during a read/fetch, so the next idle page runs immediately.
    scan.wakeup.borrow_and_update();
    scan.outcome = enrich_page(
        store,
        scan.stream,
        &mut scan.after,
        RECEIPT_TIMEOUT,
        domain_rpc_permits,
    )
    .await;
    scan
}

async fn monitor_backlog(
    store: &HyperlaneDbStore,
    poll_interval: Duration,
    oldest_pending_seconds: &GaugeVec,
) {
    loop {
        if let result @ (Err(_) | Ok(Err(_))) = timeout(
            RECEIPT_TIMEOUT,
            update_pending_age(store, oldest_pending_seconds),
        )
        .await
        {
            warn!(
                domain = store.domain.id(),
                ?result,
                "Receipt backlog measurement failed; retrying"
            );
        }
        sleep(poll_interval).await;
    }
}

/// Sample receipt backlogs, restricting dispatch to its provisional suffix.
/// This runs on the polling cadence, independently of receipt fetches and pages.
async fn update_pending_age(
    store: &HyperlaneDbStore,
    oldest_pending_seconds: &GaugeVec,
) -> eyre::Result<()> {
    for stream in ReceiptStream::ALL {
        let _db_permit = RECEIPT_DB_PERMITS.acquire().await?;
        let age = store
            .db
            .pending_receipt_age(store.domain.id(), stream)
            .await?;
        oldest_pending_seconds
            .with_label_values(&[store.domain.name(), stream.metric_label()])
            .set(age);
    }
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
