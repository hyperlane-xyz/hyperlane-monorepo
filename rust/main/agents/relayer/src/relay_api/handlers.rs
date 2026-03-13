use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use derive_new::new;
use hyperlane_base::db::HyperlaneRocksDB;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info};

use super::extractor::ProviderRegistry;

#[derive(Clone, new)]
pub struct ServerState {
    #[new(default)]
    rate_limiter: Option<Arc<RwLock<RateLimiter>>>,
    #[new(default)]
    provider_registry: Option<ProviderRegistry>,
    #[new(default)]
    dbs: Option<HashMap<u32, HyperlaneRocksDB>>,
}

impl ServerState {
    pub fn with_provider_registry(mut self, registry: ProviderRegistry) -> Self {
        self.provider_registry = Some(registry);
        self
    }

    pub fn with_dbs(mut self, dbs: HashMap<u32, HyperlaneRocksDB>) -> Self {
        self.dbs = Some(dbs);
        self
    }
}

impl ServerState {
    pub fn router(self) -> Router {
        use tower_http::cors::CorsLayer;

        let cors = CorsLayer::permissive();

        Router::new()
            .route("/relay", post(create_relay))
            .layer(cors)
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
    pub message_id: String,
    pub origin: u32,
    pub destination: u32,
    pub nonce: u32,
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

// POST /relay - Extract message and insert into database
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

    // 1. Extract message using ProviderRegistry
    let registry = state.provider_registry.as_ref().ok_or_else(|| {
        ServerError::InternalError("Provider registry not configured".to_string())
    })?;

    let extracted = registry
        .extract_message(&req.origin_chain, &req.tx_hash)
        .await
        .map_err(|e| ServerError::InvalidRequest(format!("Failed to extract message: {}", e)))?;

    info!(
        message_id = ?extracted.message_id,
        origin = extracted.origin_domain,
        destination = extracted.destination_domain,
        "Successfully extracted message"
    );

    // 2. Get database for origin chain
    let dbs = state
        .dbs
        .as_ref()
        .ok_or_else(|| ServerError::InternalError("Databases not configured".to_string()))?;

    let db = dbs.get(&extracted.origin_domain).ok_or_else(|| {
        ServerError::InternalError(format!(
            "No database for origin domain {}",
            extracted.origin_domain
        ))
    })?;

    // 3. Insert message into DB with a block number that ensures it gets processed
    // Using u64::MAX - 1000 to be ahead of any indexer cursor but not overflow
    // This is a workaround since we don't fetch the actual block number from the tx
    // The relayer uses cursor-based indexing, so we need to be ahead of the current cursor
    let block_number = u64::MAX - 1000;

    db.upsert_message(&extracted.message, block_number)
        .map_err(|e| ServerError::InternalError(format!("Failed to insert message: {}", e)))?;

    info!(
        message_id = ?extracted.message_id,
        block_number = block_number,
        "Successfully inserted message into database"
    );

    // 4. Return success immediately
    Ok(Json(RelayResponse {
        message_id: format!("{:x}", extracted.message_id),
        origin: extracted.origin_domain,
        destination: extracted.destination_domain,
        nonce: extracted.message.nonce,
    }))
}
