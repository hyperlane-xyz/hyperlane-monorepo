use std::{future::Future, time::Duration};

use tokio::time::sleep;
use tracing::{error, info};

use crate::{
    error::{IsRetryable, SubmitterError},
    payload_dispatcher::metrics::Metrics,
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
                state
                    .metrics
                    .update_call_retries_metric(&format!("{err:?}"), action);
            }
        }
    }
}

pub async fn update_tx_status(
    state: &PayloadDispatcherState,
    tx: &mut Transaction,
    new_status: TransactionStatus,
) -> Result<(), SubmitterError> {
    if new_status == tx.status {
        return Ok(());
    }
    info!(?tx, ?new_status, "Updating tx status");
    tx.status = new_status;
    state.store_tx(tx).await;
    match tx.status {
        TransactionStatus::Finalized => {
            state.metrics.update_finalized_transactions_metric();
        }
        TransactionStatus::Dropped(ref reason) => {
            state
                .metrics
                .update_dropped_transactions_metric(&format!("{reason:?}"));
        }
        _ => {}
    }
    Ok(())
}
