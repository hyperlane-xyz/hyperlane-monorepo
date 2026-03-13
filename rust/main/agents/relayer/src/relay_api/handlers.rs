use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use derive_new::new;
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_core::{PendingOperationStatus, QueueOperation};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::UnboundedSender;
use tracing::{error, info};

use super::extractor::ProviderRegistry;
use crate::msg::pending_message::{MessageContext, PendingMessage};

#[derive(Clone, new)]
pub struct ServerState {
    #[new(default)]
    rate_limiter: Option<Arc<RwLock<RateLimiter>>>,
    #[new(default)]
    provider_registry: Option<ProviderRegistry>,
    #[new(default)]
    dbs: Option<HashMap<u32, HyperlaneRocksDB>>,
    #[new(default)]
    send_channels: Option<HashMap<u32, UnboundedSender<QueueOperation>>>,
    #[new(default)]
    msg_ctxs: Option<HashMap<(u32, u32), Arc<MessageContext>>>,
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

    pub fn with_send_channels(
        mut self,
        channels: HashMap<u32, UnboundedSender<QueueOperation>>,
    ) -> Self {
        self.send_channels = Some(channels);
        self
    }

    pub fn with_msg_ctxs(mut self, ctxs: HashMap<(u32, u32), Arc<MessageContext>>) -> Self {
        self.msg_ctxs = Some(ctxs);
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

    // 2. Get send channel for destination
    let send_channels = state
        .send_channels
        .as_ref()
        .ok_or_else(|| ServerError::InternalError("Send channels not configured".to_string()))?;

    let send_channel = send_channels
        .get(&extracted.destination_domain)
        .ok_or_else(|| {
            ServerError::InvalidRequest(format!(
                "No send channel for destination domain {}",
                extracted.destination_domain
            ))
        })?;

    // 3. Get message context for (origin, destination)
    let msg_ctxs = state
        .msg_ctxs
        .as_ref()
        .ok_or_else(|| ServerError::InternalError("Message contexts not configured".to_string()))?;

    let msg_ctx = msg_ctxs
        .get(&(extracted.origin_domain, extracted.destination_domain))
        .ok_or_else(|| {
            ServerError::InternalError(format!(
                "No message context for origin {} to destination {}",
                extracted.origin_domain, extracted.destination_domain
            ))
        })?;

    // 4. Create PendingMessage and inject directly into processor channel
    let pending_msg = PendingMessage::new(
        extracted.message.clone(),
        msg_ctx.clone(),
        PendingOperationStatus::FirstPrepareAttempt,
        None, // No app context for relay API
        10,   // Max retries
    );

    // 5. Send to MessageProcessor via channel (bypasses MessageDbLoader iterator)
    send_channel
        .send(Box::new(pending_msg) as QueueOperation)
        .map_err(|e| {
            ServerError::InternalError(format!("Failed to send message to processor: {}", e))
        })?;

    info!(
        message_id = ?extracted.message_id,
        destination = extracted.destination_domain,
        "Successfully injected message into processor channel"
    );

    // 6. Return success immediately
    Ok(Json(RelayResponse {
        message_id: format!("{:x}", extracted.message_id),
        origin: extracted.origin_domain,
        destination: extracted.destination_domain,
        nonce: extracted.message.nonce,
    }))
}
