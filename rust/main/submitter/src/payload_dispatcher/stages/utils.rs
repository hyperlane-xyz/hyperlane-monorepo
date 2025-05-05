use std::{future::Future, time::Duration};

use tokio::time::sleep;
use tracing::{error, info};

use crate::{
    error::{IsRetryable, SubmitterError},
    payload_dispatcher::metrics::DispatcherMetrics,
    transaction::{Transaction, TransactionStatus},
};

use super::PayloadDispatcherState;

pub async fn call_until_success_or_nonretryable_error<F, T, Fut>(
    f: F,
    action: &str,
    state: &PayloadDispatcherState,
) -> Result<T, SubmitterError>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, SubmitterError>>,
{
    loop {
        match f().await {
            Ok(result) => return Ok(result),
            Err(err) => {
                if err.is_retryable() {
                    error!(?err, ?action, "Error making call. Retrying...");
                    sleep(Duration::from_secs(1)).await;
                } else {
                    return Err(SubmitterError::NonRetryableError(err.to_string()));
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

pub async fn update_tx_status(
    state: &PayloadDispatcherState,
    tx: &mut Transaction,
    new_status: TransactionStatus,
) -> Result<(), SubmitterError> {
    // return early to avoid double counting metrics
    if new_status == tx.status {
        return Ok(());
    }
    info!(?tx, ?new_status, "Updating tx status");
    tx.status = new_status;
    state.store_tx(tx).await;

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
