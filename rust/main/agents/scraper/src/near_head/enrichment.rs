//! Receipt enrichment is independent of indexing and of the other event stream.
use std::time::Duration;

use prometheus::GaugeVec;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use tokio::{
    sync::Semaphore,
    time::{sleep, timeout},
};
use tracing::warn;

use crate::store::HyperlaneDbStore;

use super::store::Store;

const PAGE_SIZE: usize = 100;
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(30);
const RECEIPT_RPC_CONCURRENCY: usize = 16;
const RECEIPT_RPC_DOMAIN_CONCURRENCY: usize = 4;
const RECEIPT_DB_CONCURRENCY: usize = 5;
static RECEIPT_RPC_PERMITS: Semaphore = Semaphore::const_new(RECEIPT_RPC_CONCURRENCY);
static RECEIPT_DB_PERMITS: Semaphore = Semaphore::const_new(RECEIPT_DB_CONCURRENCY);

/// Drain healthy full pages immediately; back off on failures and between sweeps.
/// Independent stream loops keep a slow delivery receipt from delaying gas work.
pub(super) async fn run(
    legacy: &HyperlaneDbStore,
    poll_interval: Duration,
    oldest_pending_seconds: &GaugeVec,
) {
    let domain_rpc_permits = Semaphore::new(RECEIPT_RPC_DOMAIN_CONCURRENCY);
    tokio::join!(
        run_stream(
            legacy,
            "delivered_message",
            poll_interval,
            &domain_rpc_permits
        ),
        run_stream(legacy, "gas_payment", poll_interval, &domain_rpc_permits),
        monitor_backlog(legacy, poll_interval, oldest_pending_seconds),
    );
}

async fn monitor_backlog(
    legacy: &HyperlaneDbStore,
    poll_interval: Duration,
    oldest_pending_seconds: &GaugeVec,
) {
    loop {
        if let result @ (Err(_) | Ok(Err(_))) = timeout(
            RECEIPT_TIMEOUT,
            update_pending_age(legacy, oldest_pending_seconds),
        )
        .await
        {
            warn!(
                domain = legacy.domain.id(),
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
    legacy: &HyperlaneDbStore,
    oldest_pending_seconds: &GaugeVec,
) -> eyre::Result<()> {
    for (table, column, event_type) in [
        ("delivered_message", "destination_tx_id", "delivery"),
        ("gas_payment", "tx_id", "gas_payment"),
    ] {
        let _db_permit = RECEIPT_DB_PERMITS.acquire().await?;
        let row = legacy
            .db
            .clone_connection()
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!(
                    "SELECT coalesce((SELECT greatest(0, extract(epoch FROM \
                    ((clock_timestamp() AT TIME ZONE 'UTC') - time_created))::double precision) \
                    FROM confirmed_{table} WHERE domain=$1 AND {column} IS NULL \
                    AND block_hash IS NOT NULL ORDER BY id LIMIT 1),0::double precision) AS age"
                ),
                [i32::from_ne_bytes(legacy.domain.id().to_ne_bytes()).into()],
            ))
            .await?
            .ok_or_else(|| eyre::eyre!("Missing receipt backlog age"))?;
        oldest_pending_seconds
            .with_label_values(&[legacy.domain.name(), event_type])
            .set(row.try_get("", "age")?);
    }
    Ok(())
}

async fn run_stream(
    legacy: &HyperlaneDbStore,
    table: &str,
    poll_interval: Duration,
    domain_rpc_permits: &Semaphore,
) {
    let mut after = 0;
    let salt = if table == "gas_payment" { 1 } else { 0 };
    let stagger_period = u64::try_from(poll_interval.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    let stagger = if cfg!(test) {
        0
    } else {
        u64::from(legacy.domain.id())
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            .saturating_mul(2)
            .saturating_add(salt)
            .checked_rem(stagger_period)
            .unwrap_or_default()
    };
    sleep(Duration::from_millis(stagger)).await;
    loop {
        let more = enrich_page(
            legacy,
            table,
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
    legacy: &HyperlaneDbStore,
    table: &str,
    after: &mut i64,
    deadline: Duration,
    domain_rpc_permits: &Semaphore,
) -> bool {
    let store = Store {
        db: legacy.db.clone_connection(),
        domain: legacy.domain.id(),
    };
    let start = *after;
    let result = timeout(deadline, async {
        let db_permit = RECEIPT_DB_PERMITS.acquire().await?;
        let rows = store.unenriched(table, start).await?;
        drop(db_permit);
        *after = rows.last().map(|(id, _)| *id).unwrap_or(0);
        let complete = legacy
            .ensure_transactions_for_known_blocks(
                rows.iter().map(|(_, meta)| meta),
                &RECEIPT_RPC_PERMITS,
                domain_rpc_permits,
                &RECEIPT_DB_PERMITS,
            )
            .await?;
        Ok::<_, eyre::Report>(complete && rows.len() == PAGE_SIZE)
    })
    .await;

    // Persisted successes are linked even when another receipt timed out. Keep
    // this separate from fetch cancellation, but bound its own database wait.
    let linked = if *after > start {
        let result = timeout(deadline, async {
            let _db_permit = RECEIPT_DB_PERMITS.acquire().await?;
            store.enrich(table, start, *after).await
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            warn!(
                domain = store.domain,
                table,
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
                domain = store.domain,
                table,
                ?result,
                "Confirmed event enrichment failed; retrying"
            );
            false
        }
    }
}

#[cfg(test)]
pub(super) async fn enrich_with_timeout(
    legacy: &HyperlaneDbStore,
    cursors: &mut [i64; 2],
    deadline: Duration,
) {
    let domain_rpc_permits = Semaphore::new(RECEIPT_RPC_DOMAIN_CONCURRENCY);
    for (table, after) in ["delivered_message", "gas_payment"]
        .into_iter()
        .zip(cursors)
    {
        enrich_page(legacy, table, after, deadline, &domain_rpc_permits).await;
    }
}

#[cfg(test)]
mod tests;
