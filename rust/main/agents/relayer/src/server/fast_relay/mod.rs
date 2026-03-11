/// Fast relay HTTP endpoints
mod create_job;
mod get_status;
mod rate_limit;

pub use create_job::{create_fast_relay, CreateFastRelayRequest, CreateFastRelayResponse};
pub use get_status::get_fast_relay_status;
pub use rate_limit::{RateLimitConfig, RateLimiter};

use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};
use derive_new::new;

use crate::fast_relay::{FastRelayWorker, JobStore, ProviderRegistry};

/// Server state for fast relay endpoints
#[derive(Clone, new)]
pub struct ServerState {
    job_store: JobStore,
    #[new(default)]
    rate_limiter: Option<RateLimiter>,
    #[new(default)]
    provider_registry: Option<ProviderRegistry>,
    #[new(default)]
    worker: Option<Arc<FastRelayWorker>>,
}

impl ServerState {
    /// Build router with fast relay endpoints
    pub fn router(self) -> Router {
        Router::new()
            .route("/fast_relay", post(create_fast_relay))
            .route("/fast_relay/:id", get(get_fast_relay_status))
            .with_state(self)
    }

    /// Add rate limiter to server state
    pub fn with_rate_limiter(mut self, rate_limiter: RateLimiter) -> Self {
        self.rate_limiter = Some(rate_limiter);
        self
    }

    /// Add provider registry to server state
    pub fn with_provider_registry(mut self, provider_registry: ProviderRegistry) -> Self {
        self.provider_registry = Some(provider_registry);
        self
    }

    /// Add fast relay worker to server state
    pub fn with_worker(mut self, worker: Arc<FastRelayWorker>) -> Self {
        self.worker = Some(worker);
        self
    }
}
