use ethers::providers::HttpClientError;
use rand::Rng;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::{sleep_until, Instant};

/// Shared by concurrent requests and clones, including after a caller cancels.
#[derive(Clone, Debug, Default)]
pub(super) struct RateLimitCooldown(Arc<Mutex<Option<Instant>>>);
impl RateLimitCooldown {
    pub(super) fn active(&self) -> bool {
        self.0
            .lock()
            .expect("rate limit cooldown lock poisoned")
            .is_some_and(|until| until > Instant::now())
    }
    pub(super) fn penalize(&self) {
        let delay = Duration::from_millis(rand::thread_rng().gen_range(20_000..=25_000));
        let mut until = self.0.lock().expect("rate limit cooldown lock poisoned");
        *until = Some(
            until
                .unwrap_or_else(Instant::now)
                .max(Instant::now().checked_add(delay).expect("bounded cooldown")),
        );
    }
    pub(super) async fn wait(&self) {
        loop {
            let until = *self.0.lock().expect("rate limit cooldown lock poisoned");
            match until {
                Some(until) if until > Instant::now() => sleep_until(until).await,
                _ => return,
            }
        }
    }
    pub(super) fn error() -> HttpClientError {
        HttpClientError::JsonRpcError(
            serde_json::from_value(serde_json::json!({
                "code": 429,
                "message": "RPC endpoint is cooling down after a rate limit response"
            }))
            .expect("valid static JSON-RPC error"),
        )
    }
}
pub(super) fn is_rate_limited(error: &HttpClientError) -> bool {
    match error {
        HttpClientError::ReqwestError(error) => {
            error.status().is_some_and(|status| status.as_u16() == 429)
        }
        HttpClientError::SerdeJson { text, .. } => rate_limit_message(text),
        HttpClientError::JsonRpcError(error) => {
            error.code == 429 || rate_limit_message(&error.message)
        }
    }
}
fn rate_limit_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase().replace('_', " ");
    message.contains("429")
        || message.contains("rate limit")
        || message.contains("too many requests")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn cooldown_survives_cancelled_wait_and_is_shared() {
        let cooldown = RateLimitCooldown::default();
        cooldown.penalize();
        let clone = cooldown.clone();
        assert!(tokio::time::timeout(Duration::from_secs(1), clone.wait())
            .await
            .is_err());
        assert!(cooldown.active());
        tokio::time::advance(Duration::from_secs(18)).await;
        assert!(clone.active());
        tokio::time::advance(Duration::from_secs(7)).await;
        assert!(!cooldown.active());
        clone.wait().await;
    }

    #[test]
    fn recognizes_rate_limit_bodies_and_rpc_errors() {
        assert!(is_rate_limited(&RateLimitCooldown::error()));
        let err = serde_json::from_str::<serde_json::Value>("Too Many Requests").unwrap_err();
        assert!(is_rate_limited(&HttpClientError::SerdeJson {
            err,
            text: "Too Many Requests".into()
        }));
        assert!(!is_rate_limited(&HttpClientError::JsonRpcError(
            serde_json::from_value(serde_json::json!({
                "code": 3, "message": "execution reverted"
            }))
            .unwrap()
        )));
    }
}
