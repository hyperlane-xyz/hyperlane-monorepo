//! Receipt enrichment is independent of indexing and of the other event stream.
use std::time::Duration;

use prometheus::GaugeVec;
use tokio::{
    sync::Semaphore,
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

/// Drain healthy full pages immediately; back off on failures and between sweeps.
/// Independent stream loops keep a slow delivery receipt from delaying gas work.
pub(super) async fn run(
    store: &HyperlaneDbStore,
    poll_interval: Duration,
    oldest_pending_seconds: &GaugeVec,
) {
    let domain_rpc_permits = Semaphore::new(RECEIPT_RPC_DOMAIN_CONCURRENCY);
    tokio::join!(
        run_stream(
            store,
            ReceiptStream::Delivery,
            poll_interval,
            &domain_rpc_permits
        ),
        run_stream(
            store,
            ReceiptStream::GasPayment,
            poll_interval,
            &domain_rpc_permits
        ),
        monitor_backlog(store, poll_interval, oldest_pending_seconds),
    );
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

/// Read the first pending row through each stream's partial (domain,id) index.
/// This runs on the polling cadence, independently of receipt fetches and pages.
async fn update_pending_age(
    store: &HyperlaneDbStore,
    oldest_pending_seconds: &GaugeVec,
) -> eyre::Result<()> {
    for stream in [ReceiptStream::Delivery, ReceiptStream::GasPayment] {
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

async fn run_stream(
    store: &HyperlaneDbStore,
    stream: ReceiptStream,
    poll_interval: Duration,
    domain_rpc_permits: &Semaphore,
) {
    let mut after = 0;
    let salt = u64::from(matches!(stream, ReceiptStream::GasPayment));
    let stagger_period = u64::try_from(poll_interval.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    let stagger = if cfg!(test) {
        0
    } else {
        u64::from(store.domain.id())
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            .wrapping_mul(2)
            .wrapping_add(salt)
            .checked_rem(stagger_period)
            .unwrap_or_default()
    };
    sleep(Duration::from_millis(stagger)).await;
    loop {
        let more = enrich_page(
            store,
            stream,
            &mut after,
            RECEIPT_TIMEOUT,
            domain_rpc_permits,
        )
        .await;
        if more {
            // Each turn is bounded to one page. Let other worker tasks run even
            // when a large cache-only backlog never needs to wait for an RPC.
            tokio::task::yield_now().await;
        } else {
            sleep(poll_interval).await;
        }
    }
}

/// Return true only when a healthy full page warrants immediate catch-up.
async fn enrich_page(
    store: &HyperlaneDbStore,
    stream: ReceiptStream,
    after: &mut i64,
    deadline: Duration,
    domain_rpc_permits: &Semaphore,
) -> bool {
    let start = *after;
    let result = timeout(deadline, async {
        let db_permit = RECEIPT_DB_PERMITS.acquire().await?;
        let rows = store
            .db
            .pending_receipts(store.domain.id(), stream, start)
            .await?;
        drop(db_permit);
        *after = rows.last().map(|(id, _)| *id).unwrap_or(0);
        let complete = store
            .ensure_transactions_for_known_blocks(
                rows.iter().map(|(_, meta)| meta),
                &RECEIPT_RPC_PERMITS,
                domain_rpc_permits,
                &RECEIPT_DB_PERMITS,
            )
            .await?;
        Ok::<_, eyre::Report>(complete && rows.len() == RECEIPT_PAGE_SIZE)
    })
    .await;

    // Persisted successes are linked even when another receipt timed out. Keep
    // this separate from fetch cancellation, but bound its own database wait.
    let linked = if *after > start {
        let result = timeout(deadline, async {
            let _db_permit = RECEIPT_DB_PERMITS.acquire().await?;
            store
                .db
                .link_receipts(store.domain.id(), stream, start, *after)
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
        Ok(Ok(more)) => more && linked,
        result => {
            warn!(
                domain = store.domain.id(),
                table = stream.table(),
                ?result,
                "Confirmed event enrichment failed; retrying"
            );
            false
        }
    }
}

#[cfg(test)]
pub(super) async fn enrich_with_timeout(
    store: &HyperlaneDbStore,
    cursors: &mut [i64; 2],
    deadline: Duration,
) {
    let domain_rpc_permits = Semaphore::new(RECEIPT_RPC_DOMAIN_CONCURRENCY);
    for (stream, after) in [ReceiptStream::Delivery, ReceiptStream::GasPayment]
        .into_iter()
        .zip(cursors)
    {
        enrich_page(store, stream, after, deadline, &domain_rpc_permits).await;
    }
}

#[cfg(test)]
mod tests;
