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
                state
                    .metrics
                    .call_retries
                    .with_label_values(&[&state.domain, &format!("{err:?}"), action])
                    .inc();
            }
        }
    }
}

pub async fn update_tx_status(
    state: &PayloadDispatcherState,
    tx: &mut Transaction,
    new_status: TransactionStatus,
) -> Result<(), SubmitterError> {
    info!(?tx, ?new_status, "Updating tx status");
    tx.status = new_status;
    state.store_tx(tx).await;
    match tx.status {
        TransactionStatus::Finalized => {
            state
                .metrics
                .finalized_transactions
                .with_label_values(&[&state.domain])
                .inc();
        }
        TransactionStatus::Dropped(ref reason) => {
            state
                .metrics
                .dropped_transactions
                .with_label_values(&[&state.domain, &format!("{reason:?}")])
                .inc();
        }
        _ => {}
    }
    Ok(())
}
