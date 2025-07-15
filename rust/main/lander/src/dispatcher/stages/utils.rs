use std::{future::Future, time::Duration};

use tokio::time::sleep;
use tracing::{error, info, instrument};

use crate::{
    dispatcher::metrics::DispatcherMetrics,
    error::{IsRetryable, LanderError},
    transaction::{Transaction, TransactionStatus},
};

use super::DispatcherState;

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
