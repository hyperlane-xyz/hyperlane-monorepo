use std::{future::Future, time::Duration};

use tokio::time::sleep;
use tracing::{error, info};

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

pub async fn update_tx_status(
    state: &DispatcherState,
    tx: &mut Transaction,
    new_status: TransactionStatus,
) -> Result<(), LanderError> {
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
