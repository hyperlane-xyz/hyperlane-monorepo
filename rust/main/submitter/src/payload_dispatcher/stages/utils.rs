use std::{future::Future, time::Duration};

use tokio::time::sleep;
use tracing::{error, info};

use crate::{
    error::SubmitterError,
    transaction::{Transaction, TransactionStatus},
};

use super::PayloadDispatcherState;

pub async fn retry_until_success<F, T, Fut>(f: F, action: &str) -> T
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, SubmitterError>>,
{
    loop {
        match f().await {
            Ok(result) => return result,
            Err(err) => {
                error!(?err, ?action, "Network error making call. Retrying...");
                sleep(Duration::from_secs(1)).await;
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
    Ok(())
}
