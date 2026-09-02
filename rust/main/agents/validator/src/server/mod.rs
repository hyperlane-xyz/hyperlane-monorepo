pub mod eigen_node;
pub mod merkle_tree_insertions;

pub use eigen_node::EigenNodeApi;

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, MutexGuard},
    time::Instant,
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
    healthy_state: ValidatorReadinessState,
    blockers: BTreeMap<String, ValidatorReadinessFailure>,
}

#[derive(Debug)]
struct ValidatorReadinessFailure {
    consecutive_failures: u64,
    first_failure_at: Instant,
}

#[derive(Debug, Serialize)]
pub struct ValidatorReadinessSnapshot {
    pub(crate) state: ValidatorReadinessState,
    pub(crate) consecutive_failures: u64,
    pub(crate) failure_duration_ms: u128,
    pub(crate) signing_blocked: bool,
    pub(crate) blocked_operations: Vec<String>,
}

#[derive(Debug)]
pub struct ValidatorReadiness {
    inner: Mutex<ValidatorReadinessInner>,
}

impl Default for ValidatorReadiness {
    fn default() -> Self {
        Self {
            inner: Mutex::new(ValidatorReadinessInner {
                healthy_state: ValidatorReadinessState::Starting,
                blockers: BTreeMap::new(),
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
        inner.healthy_state = ValidatorReadinessState::WaitingForFirstMessage;
    }

    pub fn mark_operation_ready(&self, operation: &str) {
        let mut inner = self.lock();
        inner.healthy_state = ValidatorReadinessState::Ready;
        inner.blockers.remove(operation);
    }

    pub fn mark_operation_blocked(&self, operation: &str) -> ValidatorReadinessSnapshot {
        let now = Instant::now();
        let mut inner = self.lock();
        let failure =
            inner
                .blockers
                .entry(operation.to_owned())
                .or_insert(ValidatorReadinessFailure {
                    consecutive_failures: 0,
                    first_failure_at: now,
                });
        failure.consecutive_failures = failure.consecutive_failures.saturating_add(1);
        Self::snapshot_from_inner(&inner, now)
    }

    pub fn snapshot(&self) -> ValidatorReadinessSnapshot {
        let inner = self.lock();
        Self::snapshot_from_inner(&inner, Instant::now())
    }

    fn snapshot_from_inner(
        inner: &ValidatorReadinessInner,
        now: Instant,
    ) -> ValidatorReadinessSnapshot {
        let state = if inner.blockers.is_empty() {
            inner.healthy_state
        } else {
            ValidatorReadinessState::SigningBlocked
        };
        let consecutive_failures = inner
            .blockers
            .values()
            .map(|failure| failure.consecutive_failures)
            .max()
            .unwrap_or(0);
        let failure_duration_ms = inner
            .blockers
            .values()
            .map(|failure| now.saturating_duration_since(failure.first_failure_at))
            .max()
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        ValidatorReadinessSnapshot {
            state,
            consecutive_failures,
            failure_duration_ms,
            signing_blocked: state == ValidatorReadinessState::SigningBlocked,
            blocked_operations: inner.blockers.keys().cloned().collect(),
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
        readiness.mark_operation_blocked("merkle_tree_hook.tree");

        assert_eq!(
            readiness_status(test_router(readiness)).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn readiness_tracks_consecutive_failures_and_resets_after_recovery() {
        let readiness = ValidatorReadiness::default();

        readiness.mark_operation_blocked("merkle_tree_hook.tree");
        let blocked = readiness.mark_operation_blocked("merkle_tree_hook.tree");
        assert_eq!(blocked.consecutive_failures, 2);
        assert!(blocked.signing_blocked);

        readiness.mark_operation_ready("merkle_tree_hook.tree");
        let recovered = readiness.snapshot();
        assert_eq!(recovered.consecutive_failures, 0);
        assert_eq!(recovered.failure_duration_ms, 0);
        assert!(!recovered.signing_blocked);
    }

    #[test]
    fn readiness_does_not_clear_an_unrelated_blocker() {
        let readiness = ValidatorReadiness::default();

        readiness.mark_operation_blocked("merkle_tree_hook.tree");
        readiness.mark_operation_blocked("base_merkle_tree_hook.count");
        readiness.mark_waiting_for_first_message();
        readiness.mark_operation_ready("base_merkle_tree_hook.count");

        let snapshot = readiness.snapshot();
        assert_eq!(snapshot.state, ValidatorReadinessState::SigningBlocked);
        assert_eq!(
            snapshot.blocked_operations,
            vec!["merkle_tree_hook.tree".to_owned()]
        );

        readiness.mark_operation_ready("merkle_tree_hook.tree");
        assert_eq!(readiness.snapshot().state, ValidatorReadinessState::Ready);
    }
}
