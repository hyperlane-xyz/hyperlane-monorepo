pub mod eigen_node;
pub mod merkle_tree_insertions;

pub use eigen_node::EigenNodeApi;

use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use axum::{http::StatusCode, response::IntoResponse, routing::get, Json, Router};

use hyperlane_base::CoreMetrics;
use hyperlane_core::HyperlaneDomain;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidatorReadinessState {
    Starting,
    WaitingForFirstMessage,
    Ready,
    SigningBlocked,
}

#[derive(Debug)]
struct ValidatorReadinessInner {
    state: ValidatorReadinessState,
    consecutive_failures: u64,
    first_failure_at: Option<Instant>,
}

#[derive(Debug, Serialize)]
pub struct ValidatorReadinessSnapshot {
    pub(crate) state: ValidatorReadinessState,
    pub(crate) consecutive_failures: u64,
    pub(crate) failure_duration_ms: u128,
    pub(crate) signing_blocked: bool,
}

#[derive(Debug)]
pub struct ValidatorReadiness {
    inner: Mutex<ValidatorReadinessInner>,
}

impl Default for ValidatorReadiness {
    fn default() -> Self {
        Self {
            inner: Mutex::new(ValidatorReadinessInner {
                state: ValidatorReadinessState::Starting,
                consecutive_failures: 0,
                first_failure_at: None,
            }),
        }
    }
}

impl ValidatorReadiness {
    fn lock(&self) -> MutexGuard<'_, ValidatorReadinessInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn mark_waiting_for_first_message(&self) {
        let mut inner = self.lock();
        inner.state = ValidatorReadinessState::WaitingForFirstMessage;
        inner.consecutive_failures = 0;
        inner.first_failure_at = None;
    }

    pub fn mark_ready(&self) {
        let mut inner = self.lock();
        inner.state = ValidatorReadinessState::Ready;
        inner.consecutive_failures = 0;
        inner.first_failure_at = None;
    }

    pub fn mark_signing_blocked(&self) -> ValidatorReadinessSnapshot {
        let now = Instant::now();
        let mut inner = self.lock();
        inner.state = ValidatorReadinessState::SigningBlocked;
        inner.consecutive_failures = inner.consecutive_failures.saturating_add(1);
        let first_failure_at = *inner.first_failure_at.get_or_insert(now);
        Self::snapshot_from_inner(&inner, now.saturating_duration_since(first_failure_at))
    }

    pub fn snapshot(&self) -> ValidatorReadinessSnapshot {
        let inner = self.lock();
        let failure_duration = inner
            .first_failure_at
            .map(|started_at| Instant::now().saturating_duration_since(started_at))
            .unwrap_or(Duration::ZERO);
        Self::snapshot_from_inner(&inner, failure_duration)
    }

    fn snapshot_from_inner(
        inner: &ValidatorReadinessInner,
        failure_duration: Duration,
    ) -> ValidatorReadinessSnapshot {
        ValidatorReadinessSnapshot {
            state: inner.state,
            consecutive_failures: inner.consecutive_failures,
            failure_duration_ms: failure_duration.as_millis(),
            signing_blocked: inner.state == ValidatorReadinessState::SigningBlocked,
        }
    }
}

async fn readiness_handler(readiness: Arc<ValidatorReadiness>) -> impl IntoResponse {
    let snapshot = readiness.snapshot();
    let status = match snapshot.state {
        ValidatorReadinessState::WaitingForFirstMessage | ValidatorReadinessState::Ready => {
            StatusCode::OK
        }
        ValidatorReadinessState::Starting | ValidatorReadinessState::SigningBlocked => {
            StatusCode::SERVICE_UNAVAILABLE
        }
    };
    (status, Json(snapshot))
}

/// Returns a vector of validator-specific endpoint routes to be served.
/// Can be extended with additional routes and feature flags to enable/disable individually.
pub fn router(
    origin_chain: HyperlaneDomain,
    metrics: Arc<CoreMetrics>,
    readiness: Arc<ValidatorReadiness>,
) -> Router {
    let eigen_node_api = EigenNodeApi::new(origin_chain, metrics);

    eigen_node_api.router().route(
        "/ready",
        get(move || readiness_handler(Arc::clone(&readiness))),
    )
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use prometheus::Registry;
    use tower::ServiceExt;

    use super::*;

    fn test_router(readiness: Arc<ValidatorReadiness>) -> Router {
        router(
            HyperlaneDomain::new_test_domain("ethereum"),
            Arc::new(
                CoreMetrics::new("validator", 9090, Registry::new())
                    .expect("test metrics should be valid"),
            ),
            readiness,
        )
    }

    async fn readiness_status(app: Router) -> StatusCode {
        app.oneshot(
            Request::builder()
                .uri("/ready")
                .body(Body::empty())
                .expect("readiness request should be valid"),
        )
        .await
        .expect("readiness request should succeed")
        .status()
    }

    #[tokio::test]
    async fn readiness_is_healthy_while_waiting_for_first_message() {
        let readiness = Arc::new(ValidatorReadiness::default());
        readiness.mark_waiting_for_first_message();

        assert_eq!(
            readiness_status(test_router(readiness)).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn readiness_is_unhealthy_while_checkpoint_signing_is_blocked() {
        let readiness = Arc::new(ValidatorReadiness::default());
        readiness.mark_signing_blocked();

        assert_eq!(
            readiness_status(test_router(readiness)).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn readiness_tracks_consecutive_failures_and_resets_after_recovery() {
        let readiness = ValidatorReadiness::default();

        readiness.mark_signing_blocked();
        let blocked = readiness.mark_signing_blocked();
        assert_eq!(blocked.consecutive_failures, 2);
        assert!(blocked.signing_blocked);

        readiness.mark_ready();
        let recovered = readiness.snapshot();
        assert_eq!(recovered.consecutive_failures, 0);
        assert_eq!(recovered.failure_duration_ms, 0);
        assert!(!recovered.signing_blocked);
    }
}
