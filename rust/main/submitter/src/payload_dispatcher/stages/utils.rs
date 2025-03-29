use std::{future::Future, time::Duration};

use eyre::Result;
use tokio::time::sleep;
use tracing::error;

use crate::transaction::Transaction;

pub async fn retry_until_success<F, T, Fut>(f: F, action: &str) -> T
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    loop {
        match f().await {
            Ok(result) => return result,
            Err(err) => {
                error!(?err, ?action, "Error making call. Retrying...");
                sleep(Duration::from_secs(1)).await;
            }
        }
    }
}
