use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use derive_new::new;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info};
use uuid::Uuid;

use super::{
    extractor::ProviderRegistry,
    job::{RelayJob, RelayStatus},
    store::JobStore,
};

#[derive(Clone, new)]
pub struct ServerState {
    job_store: JobStore,
    #[new(default)]
    rate_limiter: Option<Arc<RwLock<RateLimiter>>>,
    #[new(default)]
    provider_registry: Option<ProviderRegistry>,
    #[new(default)]
    relay_worker: Option<Arc<super::worker::RelayWorker>>,
}

impl ServerState {
    pub fn with_provider_registry(mut self, registry: ProviderRegistry) -> Self {
        self.provider_registry = Some(registry);
        self
    }

    pub fn with_relay_worker(mut self, worker: Arc<super::worker::RelayWorker>) -> Self {
        self.relay_worker = Some(worker);
        self
    }
}

impl ServerState {
    pub fn router(self) -> Router {
        Router::new()
            .route("/relay", post(create_relay))
            .route("/relay/{id}", get(get_relay_status))
            .with_state(self)
    }
}

// Request/Response types
#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    pub origin_chain: String,
    pub tx_hash: String, // Protocol-agnostic: hex string for EVM, base58 for Sealevel, etc.
}

#[derive(Debug, Serialize)]
pub struct RelayResponse {
    pub job_id: Uuid,
}

// Error handling
pub enum ServerError {
    RateLimited,
    InvalidRequest(String),
    NotFound,
    InternalError(String),
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ServerError::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "Rate limit exceeded"),
            ServerError::InvalidRequest(msg) => {
                (StatusCode::BAD_REQUEST, &*Box::leak(msg.into_boxed_str()))
            }
            ServerError::NotFound => (StatusCode::NOT_FOUND, "Job not found"),
            ServerError::InternalError(msg) => {
                error!("Internal server error: {}", msg);
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
        };
        (status, message).into_response()
    }
}

pub type ServerResult<T> = Result<T, ServerError>;

// Simple global rate limiter
pub struct RateLimiter {
    requests: Vec<u64>,
    max_requests: usize,
    window_secs: u64,
}

impl RateLimiter {
    pub fn new(max_requests: usize, window_secs: u64) -> Self {
        Self {
            requests: Vec::new(),
            max_requests,
            window_secs,
        }
    }

    pub fn check(&mut self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Remove requests outside the window
        self.requests.retain(|&t| now - t < self.window_secs);

        if self.requests.len() >= self.max_requests {
            return false;
        }

        self.requests.push(now);
        true
    }
}

// POST /relay - Create a new relay job
async fn create_relay(
    State(state): State<ServerState>,
    Json(req): Json<RelayRequest>,
) -> ServerResult<Json<RelayResponse>> {
    info!(
        origin_chain = %req.origin_chain,
        tx_hash = ?req.tx_hash,
        "Received relay request"
    );

    // Rate limit check
    if let Some(limiter) = &state.rate_limiter {
        let mut limiter = limiter.write().unwrap();
        if !limiter.check() {
            return Err(ServerError::RateLimited);
        }
    }

    // Validate request
    if req.origin_chain.is_empty() {
        return Err(ServerError::InvalidRequest(
            "origin_chain cannot be empty".to_string(),
        ));
    }

    // Create relay job
    let mut job = RelayJob::new(req.origin_chain.clone(), req.tx_hash.clone());
    let job_id = job.id;
    state.job_store.insert(job.clone());

    // Extract message and inject asynchronously
    if let (Some(registry), Some(worker)) =
        (state.provider_registry.clone(), state.relay_worker.clone())
    {
        let job_store = state.job_store.clone();
        tokio::spawn(async move {
            // Update status to extracting
            job.update_status(RelayStatus::Extracting);
            job_store.update(job.clone());

            // Extract message from transaction
            match registry
                .extract_message(&req.origin_chain, &req.tx_hash)
                .await
            {
                Ok(extracted) => {
                    info!(
                        job_id = %job_id,
                        message_id = ?extracted.message_id,
                        origin = extracted.origin_domain,
                        destination = extracted.destination_domain,
                        "Successfully extracted message"
                    );

                    // Update job with extracted info
                    job.message_id = extracted.message_id;
                    job.destination_chain = format!("domain-{}", extracted.destination_domain);
                    job_store.update(job.clone());

                    // Inject into MessageProcessor
                    if let Err(e) = worker.inject_message(job, extracted).await {
                        error!(
                            job_id = %job_id,
                            error = %e,
                            "Failed to inject message"
                        );
                    }
                }
                Err(e) => {
                    error!(
                        job_id = %job_id,
                        error = %e,
                        "Failed to extract message"
                    );
                    job.set_error(format!("Failed to extract message: {}", e));
                    job_store.update(job);
                }
            }
        });
    } else {
        error!(job_id = %job_id, "Provider registry or relay worker not configured");
        let mut job = state.job_store.get(&job_id).unwrap();
        job.set_error("Provider registry or relay worker not configured".to_string());
        state.job_store.update(job);
    }

    info!(job_id = %job_id, "Created relay job");

    Ok(Json(RelayResponse { job_id }))
}

// GET /relay/:id - Get relay job status
async fn get_relay_status(
    State(state): State<ServerState>,
    Path(id): Path<Uuid>,
) -> ServerResult<Json<RelayJob>> {
    match state.job_store.get(&id) {
        Some(job) => Ok(Json(job)),
        None => Err(ServerError::NotFound),
    }
}
