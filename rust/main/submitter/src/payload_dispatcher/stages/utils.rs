use std::{future::Future, time::Duration};

use tokio::time::sleep;
use tracing::error;

use crate::{chain_tx_adapter::DispatcherError, transaction::Transaction};

pub async fn retry_until_success<F, T, Fut>(f: F, action: &str) -> T
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, DispatcherError>>,
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
