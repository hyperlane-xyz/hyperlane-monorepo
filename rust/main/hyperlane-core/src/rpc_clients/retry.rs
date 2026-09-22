use futures::Future;
use rand::Rng;
use std::{pin::Pin, time::Duration};
use tokio::time::sleep;
use tracing::{instrument, warn};

use crate::{ChainCommunicationError, ChainResult};

/// Max number of times to retry a call for
pub const DEFAULT_MAX_RPC_RETRIES: usize = 10;

/// Duration to sleep between retries
pub const RPC_RETRY_SLEEP_DURATION: Duration = Duration::from_secs(2);

// TODO: Refactor this function into a retrying provider
/// Retry a fallible async function. Defaults to exponential backoff with jitter,
/// capped at 60 seconds; an explicit sleep duration preserves fixed-delay behavior.
#[instrument(err, skip(f))]
pub async fn call_and_retry_n_times<T>(
    mut f: impl FnMut() -> Pin<Box<dyn Future<Output = ChainResult<T>> + Send>>,
    n: usize,
    rpc_retry_sleep_duration: Option<Duration>,
) -> ChainResult<T> {
    for retry_number in 1..n {
        match f().await {
            Ok(res) => return Ok(res),
            Err(err) => {
                if retry_number == n.saturating_sub(1) {
                    return Err(err);
                }
                warn!(retries=retry_number, error=?err, "Retrying call");
                let delay = rpc_retry_sleep_duration.unwrap_or_else(|| {
                    let exponent = u32::try_from(retry_number.saturating_sub(1).min(5))
                        .expect("bounded retry exponent");
                    let base_ms = 2_000_u64.saturating_mul(1 << exponent).min(48_000);
                    Duration::from_millis(
                        base_ms.saturating_add(rand::thread_rng().gen_range(0..=base_ms / 4)),
                    )
                });
                sleep(delay).await;
            }
        }
    }

    // TODO: Return the last error, or a vec of all the error instead of this string error
    Err(ChainCommunicationError::CustomError(
        "Retrying call failed".to_string(),
    ))
}

/// Retry calling a fallible async function indefinitely, until it succeeds
pub async fn call_and_retry_indefinitely<T>(
    f: impl FnMut() -> Pin<Box<dyn Future<Output = ChainResult<T>> + Send>>,
) -> T {
    // It's ok to unwrap, because `usize::MAX * RPC_RETRY_SLEEP_DURATION` means billions of years worth of retrying
    call_and_retry_n_times(f, usize::MAX, None)
        .await
        .expect("Failed to call_and_retry_indefinitely")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Instant;

    #[tokio::test(start_paused = true)]
    async fn default_retries_back_off_and_explicit_delay_is_preserved() {
        for configured in [None, Some(Duration::from_millis(10))] {
            let mut attempts = Vec::new();
            call_and_retry_n_times(
                || {
                    attempts.push(Instant::now());
                    let done = attempts.len() == 4;
                    Box::pin(async move {
                        if done {
                            Ok(())
                        } else {
                            Err(ChainCommunicationError::from_other_str("temporary failure"))
                        }
                    })
                },
                5,
                configured,
            )
            .await
            .expect("eventual retry success");
            for (index, pair) in attempts.windows(2).enumerate() {
                let delay = pair[1].duration_since(pair[0]);
                if let Some(configured) = configured {
                    assert_eq!(delay, configured);
                } else {
                    let base = Duration::from_secs(2 << index);
                    assert!(delay >= base && delay <= base.mul_f64(1.25));
                }
            }
        }
    }
    #[tokio::test(start_paused = true)]
    async fn bounded_startup_retries_exhaust_without_a_final_sleep() {
        let start = Instant::now();
        let mut attempts = 0;
        let result: ChainResult<()> = call_and_retry_n_times(
            || {
                attempts += 1;
                Box::pin(async {
                    Err(ChainCommunicationError::from_other_str(
                        "cursor unavailable",
                    ))
                })
            },
            10,
            Some(RPC_RETRY_SLEEP_DURATION),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(attempts, 9);
        assert_eq!(start.elapsed(), Duration::from_secs(16));
    }
}
